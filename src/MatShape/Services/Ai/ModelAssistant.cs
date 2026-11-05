using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MatShape.Data;
using MatShape.Localization;
using MatShape.Services.Documents;
using Microsoft.EntityFrameworkCore;

namespace MatShape.Services.Ai;

/// <summary>What the assistant gives back to the editor: its words, the new content of the Part Studio (checked), the ids of the features it added or changed, and the run.</summary>
public sealed record AssistResult(string Message, string Content, IReadOnlyList<string> Changed, long RunId, int Tokens);

/// <summary>An assist that did not deliver: the reason for the person, a code, and for an administrator the page that fixes it.</summary>
public sealed record AssistFailure(string Message, string Code, string? SettingsUrl);

/// <summary>
/// The modelling assistant: a request in words ("a plate 80 × 40 × 6 with four holes of 6 mm") becomes features of the Part Studio. The model gets the format of the features (the same JSON the
/// editor saves), the Part Studio as it is and the request, and answers with features to add, to change or a whole new list. The code checks the answer (known kinds, unique ids, sizes) and merges
/// it; the editor builds it, shows it as one step that can be undone, and sends back the errors of features that do not build, for a repair.
/// The editor right on the document is checked here, not in the endpoint.
/// </summary>
public static class ModelAssistant
{
    public const int MaxPromptLength = 4000;
    public const int MaxFeaturesPerAnswer = 200;
    public const int MaxAttachments = 8;   // the editor allows 4; an SVG travels as its text and as a picture
    public const int MaxAttachmentBytes = 8 * 1024 * 1024;
    public const int MaxSvgBytes = 256 * 1024;

    public sealed record Request(string Prompt, JsonElement Content, IReadOnlyList<RepairError>? Errors, string? Language, IReadOnlyList<Attachment>? Attachments = null);

    public sealed record RepairError(string Id, string? Name, string Message);

    /// <summary>A file the person attached: a picture (PNG, JPEG, WebP, GIF), a PDF or an SVG, as base64.</summary>
    public sealed record Attachment(string? Name, string? MediaType, string? Data);

    private static readonly HashSet<string> ImageTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];

    /// <summary>The attached SVG files as text after the situation (empty without any).</summary>
    private static string SvgText(List<(string Name, string Text)> svgs)
    {
        var sb = new StringBuilder();
        foreach (var (name, text) in svgs)
        {
            sb.Append("\n\nAttached SVG \"").Append(name).Append("\" (a template; take its paths as outlines):\n```svg\n").Append(text).Append("\n```");
        }

        return sb.ToString();
    }

    /// <summary>
    /// The attachments as the transports take them: pictures as images, PDFs as files, SVGs as text (their paths are exact coordinates for a model).
    /// Null with a reason when one is not allowed (type, size, count, not base64).
    /// </summary>
    public static (List<AiAttachment> Files, List<(string Name, string Text)> Svgs, string? Problem) ReadAttachments(IReadOnlyList<Attachment>? list)
    {
        var files = new List<AiAttachment>();
        var svgs = new List<(string, string)>();
        if (list is null || list.Count == 0)
        {
            return (files, svgs, null);
        }

        if (list.Count > MaxAttachments)
        {
            return (files, svgs, Text.T("Ai.Attach.TooMany", MaxAttachments));
        }

        foreach (var a in list)
        {
            var name = new string((a.Name ?? "file").Where(c => !char.IsControl(c)).Take(100).ToArray());
            var type = (a.MediaType ?? string.Empty).Trim().ToLowerInvariant();
            var data = a.Data ?? string.Empty;
            var comma = data.IndexOf(',');
            if (data.StartsWith("data:", StringComparison.Ordinal) && comma > 0)
            {
                data = data[(comma + 1)..];
            }

            var bytes = new byte[data.Length * 3 / 4 + 3];
            if (data.Length == 0 || !Convert.TryFromBase64String(data, bytes, out var length))
            {
                return (files, svgs, Text.T("Ai.Attach.Unreadable", name));
            }

            if (type == "image/svg+xml")
            {
                if (length > MaxSvgBytes)
                {
                    return (files, svgs, Text.T("Ai.Attach.TooLarge", name));
                }

                svgs.Add((name, Encoding.UTF8.GetString(bytes, 0, length)));
                continue;
            }

            if (length > MaxAttachmentBytes)
            {
                return (files, svgs, Text.T("Ai.Attach.TooLarge", name));
            }

            if (ImageTypes.Contains(type))
            {
                files.Add(new AiAttachment { Kind = "image", MediaType = type, Name = name, Data = data });
            }
            else if (type == "application/pdf")
            {
                files.Add(new AiAttachment { Kind = "file", MediaType = type, Name = name, Data = data });
            }
            else
            {
                return (files, svgs, Text.T("Ai.Attach.Type", name));
            }
        }

        return (files, svgs, null);
    }

    public static async Task<(AssistResult? Result, AssistFailure? Failure)> AssistAsync(AppDbContext db, IServiceProvider services, long userId, long studioId, Request request, string? address, bool isAdmin, CancellationToken ct = default)
    {
        var studio = await db.PartStudios.AsNoTracking().Where(s => s.Id == studioId).Select(s => new { s.Id, s.DocumentId, s.Name }).FirstOrDefaultAsync(ct);
        if (studio is null || await DocumentAccess.FindAsync(db, Actor.Of(userId), studio.DocumentId, DocumentRole.Editor, ct: ct) is not { } access)
        {
            return (null, new AssistFailure(Text.T("Errors.NotFound.Text"), "denied", null));
        }

        var (files, svgs, attachProblem) = ReadAttachments(request.Attachments);
        if (attachProblem is not null)
        {
            return (null, new AssistFailure(attachProblem, "invalid", null));
        }

        var prompt = (request.Prompt ?? string.Empty).Trim();
        if (prompt.Length == 0)
        {
            if (files.Count + svgs.Count == 0)
            {
                return (null, new AssistFailure(Text.T("Ai.Assist.Empty"), "invalid", null));
            }

            prompt = Text.T("Ai.Attach.DefaultPrompt");
        }

        if (prompt.Length > MaxPromptLength)
        {
            prompt = prompt[..MaxPromptLength];
        }

        var current = request.Content.ValueKind == JsonValueKind.Object ? request.Content.GetRawText() : StudioContent.Empty;
        if (StudioContent.Validate(current) is not null)
        {
            return (null, new AssistFailure(Text.T("Save.Invalid"), "invalid", null));
        }

        var settings = await AiSettings.LoadAsync(db, ct);
        var language = Languages.Normalize(request.Language);
        var messages = new List<AiMessage>
        {
            AiMessage.System(SystemText(settings, language)),
            AiMessage.User(Situation(access.Document, studio.Name, current, prompt, request.Errors) + SvgText(svgs)),
        };
        messages[^1].Attachments = files;
        var outcome = await AiService.RunAsync(db, services, new AiService.Call(AiAction.Model, messages, "features", studio.DocumentId, studio.Id, userId, address, prompt), ct);
        if (!outcome.Ok)
        {
            var url = !isAdmin ? null : outcome.Code switch
            {
                AiService.Codes.NotConfigured => "/Admin/Ai/Profiles",
                AiService.Codes.Disabled or AiService.Codes.Limit => "/Admin/Ai",
                _ => null,
            };
            return (null, new AssistFailure(outcome.Error ?? Text.T("Ai.NoAnswer"), outcome.Code ?? AiService.Codes.Failed, url));
        }

        var answer = outcome.Result!.Value;
        var (merged, changed, problem) = Merge(current, answer);
        if (problem is not null)
        {
            outcome.Run.Status = AiRunStatus.Error;
            outcome.Run.Error = problem;
            await db.SaveChangesAsync(CancellationToken.None);
            return (null, new AssistFailure(Text.T("Ai.Assist.Invalid", problem), AiService.Codes.Failed, null));
        }

        var message = answer.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String ? m.GetString()! : string.Empty;
        return (new AssistResult(message.Length > 4000 ? message[..4000] : message, merged!, changed, outcome.Run.Id, outcome.Run.TotalTokens), null);
    }

    /// <summary>
    /// Merges the answer into the content: <c>append</c> adds the features at the end (before the rollback bar when it is moved), <c>patch</c> replaces features with the same id and adds the others,
    /// <c>replace</c> takes the list as it is. Names and colours of parts are merged in. The result is checked like everything the server stores.
    /// </summary>
    public static (string? Content, IReadOnlyList<string> Changed, string? Problem) Merge(string current, JsonElement answer)
    {
        if (!answer.TryGetProperty("features", out var features) || features.ValueKind != JsonValueKind.Array)
        {
            return (null, [], "no features list");
        }

        if (features.GetArrayLength() > MaxFeaturesPerAnswer)
        {
            return (null, [], "too many features");
        }

        var root = JsonNode.Parse(current)!.AsObject();
        var list = root["features"] as JsonArray ?? [];
        var mode = answer.TryGetProperty("mode", out var md) && md.ValueKind == JsonValueKind.String ? md.GetString() : "append";
        var changed = new List<string>();
        var incoming = features.EnumerateArray().Select(f => JsonNode.Parse(f.GetRawText())!).ToList();
        foreach (var f in incoming)
        {
            if (f is not JsonObject o || o["id"]?.GetValueKind() != JsonValueKind.String)
            {
                return (null, [], "a feature without an id");
            }

            o["params"] ??= new JsonObject();
            changed.Add(o["id"]!.GetValue<string>());
        }

        if (mode == "replace")
        {
            list = new JsonArray([.. incoming]);
            root["rollback"] = null;
        }
        else
        {
            var at = root["rollback"]?.GetValueKind() == JsonValueKind.Number ? root["rollback"]!.GetValue<int>() : list.Count;
            foreach (var f in incoming)
            {
                var id = f["id"]!.GetValue<string>();
                var index = list.Select((x, i) => (x, i)).FirstOrDefault(t => t.x?["id"]?.GetValue<string>() == id).i;
                var exists = list.Any(x => x?["id"]?.GetValue<string>() == id);
                if (exists && mode == "patch")
                {
                    list[index] = f;
                }
                else
                {
                    list.Insert(Math.Min(at, list.Count), f);
                    at++;
                    if (root["rollback"]?.GetValueKind() == JsonValueKind.Number)
                    {
                        root["rollback"] = at;
                    }
                }
            }
        }

        root["features"] = list;
        if (answer.TryGetProperty("parts", out var parts) && parts.ValueKind == JsonValueKind.Object)
        {
            var target = root["parts"] as JsonObject ?? [];
            foreach (var p in parts.EnumerateObject())
            {
                if (p.Value.ValueKind == JsonValueKind.Object)
                {
                    target[p.Name] = JsonNode.Parse(p.Value.GetRawText());
                }
            }

            root["parts"] = target;
        }

        var json = root.ToJsonString();
        return StudioContent.Validate(json) is { } problem ? (null, [], problem) : (json, changed, null);
    }

    // ---- what the model reads -------------------------------------------------------------------------------------------------

    /// <summary>The instruction: the role, the format of the Part Studio, the rules, the shape of the answer, and the addition of the site.</summary>
    public static string SystemText(AiSettings settings, string language)
    {
        var sb = new StringBuilder(Format);
        sb.Append("\n\nWrite \"message\" in ").Append(language == "de" ? "German (du-form)" : "English").Append('.');
        if (!string.IsNullOrWhiteSpace(settings.Instruction))
        {
            sb.Append("\n\nRules of this installation (follow them):\n").Append(settings.Instruction.Trim());
        }

        return sb.ToString();
    }

    /// <summary>The situation: the document, its unit, the Part Studio as JSON (the source of truth), the parts and variables, the request and, for a repair, what did not build.</summary>
    public static string Situation(Document document, string studioName, string content, string prompt, IReadOnlyList<RepairError>? errors)
    {
        var sb = new StringBuilder();
        sb.Append("Document: ").Append(document.Name).Append(" · Part Studio: ").Append(studioName).Append('\n');
        sb.Append("Unit of the document: ").Append(document.Units).Append(" (a plain number in a field means this unit)\n");
        sb.Append("Date: ").Append(DateTime.UtcNow.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture)).Append("\n\n");
        sb.Append("The Part Studio now (JSON):\n").Append(content).Append("\n\n");
        if (errors is { Count: > 0 })
        {
            sb.Append("REPAIR: your last answer was applied, but these features do not build. Fix them (mode \"patch\" with the same ids), keep what works:\n");
            foreach (var e in errors.Take(30))
            {
                sb.Append("- ").Append(e.Id).Append(" (").Append(e.Name).Append("): ").Append(e.Message).Append('\n');
            }

            sb.Append("\nThe original request was:\n");
        }
        else
        {
            sb.Append("The request:\n");
        }

        sb.Append(prompt);
        return sb.ToString();
    }

    /// <summary>The format of a Part Studio as the model must write it. Kept in one place with the editor's model.js (FEATURES) and geom.js.</summary>
    public const string Format = """
        You are the modelling assistant of MatShape, a parametric 3D CAD application (like the CAD tools on the web). You turn a request into FEATURES of a Part Studio.
        The person sees every feature in the feature list, can edit it and undo your whole answer in one step. Build real, clean parametric models.

        ## Coordinates
        Millimetres inside; Z is up. Standard planes and their 2D sketch coordinates (u, v):
        - top:   the XY plane, normal +Z; u = X, v = Y
        - front: the XZ plane, normal -Y; u = X, v = Z
        - right: the YZ plane, normal +X; u = Y, v = Z
        A plane reference is {"kind":"std","name":"top|front|right"} or {"kind":"plane","id":"<id of a plane feature>"}.

        ## Values
        Every number field is a STRING expression: "25", "2.5 cm", "1 in", "30 deg", "#width / 2", "sqrt(#a^2 + #b^2)". A plain number means the unit of the document (angles: degrees).
        #name refers to a variable feature defined EARLIER in the list. Prefer variables for the main dimensions the person named.

        ## Feature list
        "features" is an ordered list; each item: {"id": "...", "type": "...", "name": "...", "params": {...}} (optional "suppressed": true). Ids are unique; give new features ids like "ai_plate", "ai_holes" (letters, digits, _ . -).
        Kinds and their params:
        - variable:  {"name": "width", "value": "80 mm"}
        - sketch:    {"plane": <plane ref>, "entities": [ ... ]}   entities (2D, millimetres as NUMBERS, each with a unique "id"):
            line {"id","t":"line","a":[u,v],"b":[u,v]}, rect {"id","t":"rect","a":[u,v],"b":[u,v]} (two opposite corners, axis-aligned),
            circle {"id","t":"circle","c":[u,v],"r":r}, arc {"id","t":"arc","c":[u,v],"r":r,"a0":rad,"a1":rad} (counter-clockwise from a0 to a1, radians),
            polygon {"id","t":"polygon","c":[u,v],"r":circumradius,"n":sides,"rot":degrees}, point {"id","t":"point","p":[u,v]}. Add "cons": true for construction geometry (not part of profiles).
            Closed profiles: every circle, rect and polygon, and every closed chain of lines/arcs whose ends meet exactly. Nested profiles become holes. Sketch entities take numbers, not expressions.
            Optional "cons": constraints and dimensions the sketch solver holds: {"id","type":"...","refs":[...]} (dimensions add "value": an expression like "40" or "#width / 2", angles in degrees).
            A ref is a point {"e":"<entity id>","k":"a|b|c|s|e|p"} (a/b ends of a line, c centre, s/e start/end of an arc, p a point; {"e":"origin","k":"p"} = the origin) or a curve {"e":"<entity id>"}.
            Types: coincident (2 points), onCurve (point, curve), horizontal / vertical (a line, or 2 points), parallel / perpendicular (2 lines), tangent (line+circle/arc or 2 round),
            equal (2 lines or 2 round), concentric (2 round), midpoint (point, line), fix (one point or entity); dimensions: distance (2 points, or point + line, or 2 parallel lines),
            length (line), radius (arc, polygon), diameter (circle), angle (2 lines). Join the ends of chained lines with coincident so they stay closed when values change.
        - plane:     {"base": <plane ref>, "offset": "20", "flip": false}   a plane parallel to base, moved along its normal.
        - extrude:   {"sketch": "<sketch id>", "profiles": null, "depth": "10", "end": "blind|symmetric|through", "flip": false, "op": "new|add|remove|intersect", "scope": null}
                     Along the normal of the sketch plane (flip = the other way). op: new makes parts; add joins the parts it touches; remove cuts (use "through" for through-holes);
                     intersect keeps the common volume. "scope": null = all parts, or a list of part ids. "profiles": null = all closed profiles.
        - revolve:   {"sketch": "<id>", "profiles": null, "axis": "x|y|<id of a line entity>", "angle": "360", "symmetric": false, "flip": false, "op": "new|add|remove|intersect", "scope": null}
                     The profile must lie on one side of the axis. "x"/"y" are the u/v axes of the sketch through its origin.
        - boolean:   {"op": "union|subtract|intersect", "targets": [part ids], "tools": [part ids], "keep": false}
        - transform: {"parts": [part ids], "dx": "0", "dy": "0", "dz": "0", "axis": "x|y|z", "angle": "0", "copy": false}  (rotation about a world axis through the origin, then the move)
        - mirror:    {"parts": [part ids], "plane": <plane ref>, "merge": true}
        - lpattern:  {"parts": [part ids], "dir": "x|y|z", "flip": false, "distance": "20", "count": "3", "merge": false}   count includes the original
        - cpattern:  {"parts": [part ids], "axis": "x|y|z", "count": "6", "angle": "360", "merge": false}   about a world axis through the origin
        - split:     {"parts": [part ids], "plane": <plane ref>, "keep": "both|front|back"}
        - deletepart:{"parts": [part ids]}
        - fillet:    {"edges": [edge refs], "radius": "2"}   rounds edges: outer edges are cut round, inner edges filled round
        - chamfer:   {"edges": [edge refs], "mode": "equal|two", "distance": "1", "distance2": "2", "flip": false}   bevels edges (two: distance on one face, distance2 on the other)
                     An edge ref names the two faces that meet there: {"part": "<part id>", "faces": ["<face>", "<face>"]}; {"part": "<id>", "face": "<face>"} = every edge of
                     that face; {"part": "<id>"} = every edge of the part. Faces are named after the feature that made them: "<extrude id>:start" (on the sketch plane),
                     "<extrude id>:end" (the far end), "<extrude id>:<entity id>" (the side made by that sketch entity; the sides of a rect are "<rect id>.0" .. ".3":
                     y = a.y, x = b.x, y = b.y, x = a.x), "<revolve id>:<entity id>". Example, the top edges of the plate ai_plate: {"part": "ai_plate", "face": "ai_plate:end"}.
        - hole:      {"sketch": "<id>", "kind": "simple|cbore|csink", "diameter": "6", "end": "through|blind", "depth": "10", "cbDiameter": "11", "cbDepth": "6", "csDiameter": "12",
                     "csAngle": "90", "tipAngle": "118", "flip": false, "thread": false, "pitch": "1", "scope": null}   a hole at every point and circle centre of the sketch,
                     into the material against the normal of the sketch plane (put the sketch on the face plane). thread: an internal thread cut into the wall.
        - shell:     {"faces": [{"part": "<id>", "face": "<face>"}], "thickness": "2"}   hollows the part, the faces given are opened ({"part": "<id>"} alone: closed hollow)
        - rib:       {"sketch": "<id>", "thickness": "3", "flip": false, "scope": null}   a line in a sketch through the parts: fills between it and the parts, as thick as given
        - sweep:     {"sketch": "<profile sketch>", "profiles": null, "path": "<sketch with the path>", "op": "new|add|remove|intersect", "scope": null}   the profile
                     (drawn at the start of the path) moved along the chain of lines/arcs/splines of the path sketch
        - loft:      {"sketches": ["<id>", "<id>", ...], "op": "new|add|remove|intersect", "scope": null}   a smooth body through the biggest profile of each sketch, in order
        - draft:     {"faces": [face refs], "neutral": <plane ref>, "angle": "3", "flip": false}   tilts faces about where they meet the neutral plane
        - thread:    {"faces": [face refs of round faces], "pitch": "1.5", "depth": "", "length": "", "left": false, "flip": false}   a 60° thread cut into a shaft or hole

        ## Part ids
        A part is named after the feature that made it: an extrude/revolve with op "new" that makes one body gives the part id = the feature id; several separate bodies give "<id>.0", "<id>.1" ...
        Copies: transform with copy "<id>.<i>", mirror without merge "<id>.<i>", patterns without merge "<id>.<i>.<k>" (i = index of the source part, k = 1..count-1).
        A split keeps the source id for one half and "<sourceId>~<featureId>" for the other. "add"/"remove" keep the id of the part they change. Only refer to parts that exist BEFORE a feature.
        Part names and colours: optional "parts": {"<part id>": {"name": "Bracket", "color": "#9fb3c8"}}.

        ## Good practice
        - Holes and pockets: a sketch on the face plane (or a std plane) and extrude with op "remove" (end "through" for through-holes). Patterns of holes: sketch all circles in ONE sketch, or pattern a tool part and subtract it with boolean.
        - Round parts (shafts, knobs, bottles): a closed half-profile on the front plane right of the v-axis and revolve about "y".
        - Put a body on a face: a plane feature with the right offset, a sketch on it, extrude with op "add".
        - Keep the history short and readable, with clear names (in the language of the person). Do not repeat features that already exist; change them with mode "patch".

        ## Answer
        Exactly ONE JSON object, no Markdown:
        {"message": "what you did, in one to three sentences; name open questions", "mode": "append|patch|replace", "features": [ ... ], "parts": { ... optional ... }}
        - append: the features are added at the end (the usual case for something new)
        - patch: features with an existing id replace that feature in place; new ids are added at the end (to change or fix features)
        - replace: the whole list is replaced (only when the person asks to start over)
        If the request is not about modelling or cannot be done, answer with "features": [] and explain it in "message".
        Attachments: the person may attach pictures (photos, drawings, screenshots), PDFs or SVG files.
        - A picture of an object to rebuild: model it with the features above. Take sizes from the text or the picture (dimension lines, known parts like screws); where none are given,
          choose plausible ones and say which in "message". Rebuild the main shape first, then holes, pockets and patterns.
        - A logo, icon or lettering as a template: trace its outlines as closed sketch profiles (lines, arcs, circles; holes as inner profiles) on the Top plane, centred on the origin, about
          60 mm wide unless a size is asked for, then extrude them (for example a 2 mm base plate and the logo 1.5 mm raised on it with "op": "add"). From an SVG take the coordinates of
          its paths (flip y: SVG y points down), approximate curves with arcs or short lines.
        """;
}
