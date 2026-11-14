using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using MatShape.Data;
using MatShape.Localization;
using MatShape.Services.Models;
using Microsoft.EntityFrameworkCore;

namespace MatShape.Services.Ai;

/// <summary>
/// What the assistant gives back to the editor: its words, the new content of the Part Studio (checked), the ids of the features it added or changed and of the ones it
/// deleted, and the run.
/// </summary>
public sealed record AssistResult(string Message, string Content, IReadOnlyList<string> Changed, long RunId, int Tokens, IReadOnlyList<string>? Removed = null);

/// <summary>An assist that did not deliver: the reason for the person, a code, and for an administrator the page that fixes it.</summary>
public sealed record AssistFailure(string Message, string Code, string? SettingsUrl);

/// <summary>
/// The modelling assistant: a request in words ("a plate 80 × 40 × 6 with four holes of 6 mm") becomes features of the Part Studio. The model gets the format of the features (the same JSON the
/// editor saves), the Part Studio as it is and the request, and answers with features to add, to change or a whole new list. The code checks the answer (known kinds, unique ids, sizes) and merges
/// it; the editor builds it, shows it as one step that can be undone, and sends back the errors of features that do not build, for a repair.
/// The editor right on the model is checked here, not in the endpoint.
/// </summary>
public static class ModelAssistant
{
    public const int MaxPromptLength = 4000;
    public const int MaxFeaturesPerAnswer = 200;
    public const int MaxAttachments = 8;   // the editor allows 4; an SVG travels as its text and as a picture
    public const int MaxAttachmentBytes = 8 * 1024 * 1024;
    public const int MaxSvgBytes = 256 * 1024;

    /// <summary>
    /// One request. <c>Errors</c> and <c>Overlaps</c> come in a repair round (what did not build, which separate parts interpenetrate after the last answer);
    /// <c>Detail</c> is the level of detail the person chose: rough, normal or fine.
    /// </summary>
    public sealed record Request(
        string Prompt, JsonElement Content, IReadOnlyList<RepairError>? Errors, string? Language, IReadOnlyList<Attachment>? Attachments = null,
        IReadOnlyList<Overlap>? Overlaps = null, string? Detail = null);

    public sealed record RepairError(string Id, string? Name, string Message);

    /// <summary>Two separate parts that share volume (mm³) – found by the editor with the kernel after an answer was built.</summary>
    public sealed record Overlap(string A, string? AName, string B, string? BName, double Volume);

    /// <summary>The levels of detail and what they ask of the model.</summary>
    public static readonly IReadOnlyDictionary<string, string> Details = new Dictionary<string, string>
    {
        ["rough"] = "ROUGH – only the main shapes and what the person named; no fillets, chamfers or extras unless asked. Few features.",
        ["normal"] = "NORMAL – a finished-looking part as a designer would draw it: the main shape in good proportions, every functional feature (holes with real "
            + "sizes, pockets, bosses, ribs, slots), fillets on the outer edges and chamfers on holes and edges you touch. Rather more features than too few.",
        ["fine"] = "FINE – like a production part: everything of NORMAL plus every detail that belongs to such an object (standard sizes for screws and threads, "
            + "counterbores, fillets on all edges that would be rounded, inner fillets, draft on moulded faces, wall thickness, ribs, markings or text where they "
            + "make sense, separate parts for separate pieces). Build it step by step with many features; accuracy matters more than brevity.",
    };

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
        var studio = await db.PartStudios.AsNoTracking().Where(s => s.Id == studioId).Select(s => new { s.Id, s.ModelId, s.Name }).FirstOrDefaultAsync(ct);
        if (studio is null || await ModelAccess.FindAsync(db, Actor.Of(userId), studio.ModelId, ModelRole.Editor, ct: ct) is not { } access)
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
            AiMessage.User(Situation(access.Model, studio.Name, current, prompt, request.Errors, request.Overlaps, request.Detail) + SvgText(svgs)),
        };
        messages[^1].Attachments = files;
        var outcome = await AiService.RunAsync(db, services, new AiService.Call(AiAction.Model, messages, "features", studio.ModelId, studio.Id, userId, address, prompt), ct);
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
        var (merged, changed, removed, problem) = Merge(current, answer);
        if (problem is not null)
        {
            outcome.Run.Status = AiRunStatus.Error;
            outcome.Run.Error = problem;
            await db.SaveChangesAsync(CancellationToken.None);
            return (null, new AssistFailure(Text.T("Ai.Assist.Invalid", problem), AiService.Codes.Failed, null));
        }

        var message = answer.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String ? m.GetString()! : string.Empty;
        return (new AssistResult(message.Length > 4000 ? message[..4000] : message, merged!, changed, outcome.Run.Id, outcome.Run.TotalTokens, removed), null);
    }

    /// <summary>
    /// Merges the answer into the content: <c>append</c> adds the features at the end (before the rollback bar when it is moved), <c>patch</c> replaces features with the same id and adds the others,
    /// <c>replace</c> takes the list as it is; <c>remove</c> (a list of ids) deletes features, with any mode. Names and colours of parts are merged in. The result is checked like
    /// everything the server stores.
    /// </summary>
    public static (string? Content, IReadOnlyList<string> Changed, IReadOnlyList<string> Removed, string? Problem) Merge(string current, JsonElement answer)
    {
        var toRemove = answer.TryGetProperty("remove", out var rm) && rm.ValueKind == JsonValueKind.Array
            ? rm.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => x.GetString()!).Distinct().ToList()
            : [];
        JsonElement features;
        if (!answer.TryGetProperty("features", out features) || features.ValueKind != JsonValueKind.Array)
        {
            if (toRemove.Count == 0)
            {
                return (null, [], [], "no features list");
            }

            features = JsonDocument.Parse("[]").RootElement;
        }

        if (features.GetArrayLength() > MaxFeaturesPerAnswer)
        {
            return (null, [], [], "too many features");
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
                return (null, [], [], "a feature without an id");
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

        // deleted: features that are wrong or no longer needed (the rollback bar stays after the same features)
        var removed = new List<string>();
        foreach (var id in toRemove)
        {
            var index = list.Select((x, i) => (x, i)).Where(t => t.x?["id"]?.GetValue<string>() == id).Select(t => t.i).DefaultIfEmpty(-1).First();
            if (index < 0)
            {
                continue;
            }

            list.RemoveAt(index);
            removed.Add(id);
            if (root["rollback"]?.GetValueKind() == JsonValueKind.Number && index < root["rollback"]!.GetValue<int>())
            {
                root["rollback"] = root["rollback"]!.GetValue<int>() - 1;
            }
        }

        changed.RemoveAll(removed.Contains);
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
        return StudioContent.Validate(json) is { } problem ? (null, [], [], problem) : (json, changed, removed, null);
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

    /// <summary>
    /// The situation: the model, its unit, the level of detail, the Part Studio as JSON (the source of truth), the request and, for a repair, what did not build and which
    /// separate parts interpenetrate.
    /// </summary>
    public static string Situation(
        Model model, string studioName, string content, string prompt, IReadOnlyList<RepairError>? errors, IReadOnlyList<Overlap>? overlaps = null, string? detail = null)
    {
        var sb = new StringBuilder();
        sb.Append("Model: ").Append(model.Name).Append(" · Part Studio: ").Append(studioName).Append('\n');
        sb.Append("Unit of the model: ").Append(model.Units).Append(" (a plain number in a field means this unit)\n");
        sb.Append("Level of detail asked: ").Append(Details.TryGetValue(detail ?? string.Empty, out var level) ? level : Details["normal"]).Append('\n');
        sb.Append("Date: ").Append(DateTime.UtcNow.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture)).Append("\n\n");
        sb.Append("The Part Studio now (JSON):\n").Append(content).Append("\n\n");
        if (errors is { Count: > 0 } || overlaps is { Count: > 0 })
        {
            sb.Append("REPAIR: your last answer was applied, but it is not right yet. Fix it (mode \"patch\" with the same ids; \"remove\" for features that are wrong), keep what works.\n");
            if (errors is { Count: > 0 })
            {
                sb.Append("These features do not build:\n");
                foreach (var e in errors.Take(30))
                {
                    sb.Append("- ").Append(e.Id).Append(" (").Append(e.Name).Append("): ").Append(e.Message).Append('\n');
                }
            }

            if (overlaps is { Count: > 0 })
            {
                sb.Append("These separate parts overlap (interpenetrate). That is not allowed: one physical part is ONE solid, separate parts may only touch. Join what belongs ")
                  .Append("together into one part (op \"add\" instead of \"new\", or a boolean union), or move / resize the pieces so that they only touch:\n");
                foreach (var o in overlaps.Take(30))
                {
                    sb.Append("- part ").Append(o.A).Append(" (").Append(o.AName).Append(") and part ").Append(o.B).Append(" (").Append(o.BName).Append("): ")
                      .Append(o.Volume.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture)).Append(" mm³ in common\n");
                }
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
        Every number field is a STRING expression: "25", "2.5 cm", "1 in", "30 deg", "#width / 2", "sqrt(#a^2 + #b^2)". A plain number means the unit of the model (angles: degrees).
        #name refers to a variable feature defined EARLIER in the list. Prefer variables for the main dimensions the person named.

        ## Feature list
        "features" is an ordered list; each item: {"id": "...", "type": "...", "name": "...", "params": {...}} (optional "suppressed": true). Ids are unique; give new features ids like "ai_plate", "ai_holes" (letters, digits, _ . -).
        Kinds and their params:
        - variable:  {"name": "width", "value": "80 mm"}
        - sketch:    {"plane": <plane ref>, "entities": [ ... ]}   entities (2D, millimetres as NUMBERS, each with a unique "id"):
            line {"id","t":"line","a":[u,v],"b":[u,v]}, rect {"id","t":"rect","a":[u,v],"b":[u,v]} (two opposite corners, axis-aligned),
            circle {"id","t":"circle","c":[u,v],"r":r}, arc {"id","t":"arc","c":[u,v],"r":r,"a0":rad,"a1":rad} (counter-clockwise from a0 to a1, radians),
            polygon {"id","t":"polygon","c":[u,v],"r":circumradius,"n":sides,"rot":degrees}, ellipse {"id","t":"ellipse","c":[u,v],"rx":a,"ry":b,"rot":radians},
            point {"id","t":"point","p":[u,v]}. Add "cons": true for construction geometry (not part of profiles).
            Rounded outlines: chain lines and arcs (an arc meets its lines exactly at its ends) instead of plain rectangles when the object is rounded.
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
        - import:    a CAD file the person imported (its bodies are not shown to you); its parts can be used like others. Never write one.
        - thread:    {"faces": [face refs of round faces], "pitch": "1.5", "depth": "", "length": "", "left": false, "flip": false}   a 60° thread cut into a shaft or hole
        - figure:    {"scale": "1", "detail": "rough|normal|fine", "flat": true, "parts": [ {"name": "Fur", "color": "#8b5a2b", "smooth": 3, "blocks": [ ... ]}, ... ]}
                     A FREE, ORGANIC form of building blocks that melt into each other: mascots, animals, characters, figurines, toys, food, plants, soft objects, sculptures.
                     Each entry of "parts" is ONE part in its own colour; its blocks are joined smoothly ("smooth" = how far they blend, mm; 0 = sharp). Blocks (NUMBERS in mm, Z up):
                     sphere {"t":"sphere","c":[x,y,z],"r":r}; ellipsoid {"t":"ellipsoid","c":[x,y,z],"r":[rx,ry,rz]}; capsule {"t":"capsule","a":[x,y,z],"b":[x,y,z],"r":r,"r2":r_at_b}
                     (limbs, necks, tails, fingers; r2 tapers it); cone {"t":"cone","a":[..],"b":[..],"ra":r,"rb":r} (flat ends: hats, beaks, horns, noses);
                     box {"t":"box","c":[..],"size":[x,y,z],"round":r}; cylinder {"t":"cylinder","c":[..],"r":r,"h":h,"round":r} (upright); torus {"t":"torus","c":[..],"R":R,"r":r} (lying).
                     Optional on every block: "rot": [ax,ay,az] degrees (about X, then Y, then Z, around c), "op": "cut" (carves it away: mouths, eye sockets, holes), "blend": its own smoothness.
                     Blocks act in their order (a cut removes what came before it). A later part is cut out of the earlier parts it reaches into, so the colours fit together
                     (put eyes, a nose, a belly patch, a logo badge AFTER the body and let them stick out 0.5–2 mm). "flat": true cuts everything below Z = 0 (it stands and prints).

        ## Part ids
        A part is named after the feature that made it: an extrude/revolve with op "new" that makes one body gives the part id = the feature id; several separate bodies give "<id>.0", "<id>.1" ...
        Copies: transform with copy "<id>.<i>", mirror without merge "<id>.<i>", patterns without merge "<id>.<i>.<k>" (i = index of the source part, k = 1..count-1).
        A split keeps the source id for one half and "<sourceId>~<featureId>" for the other. "add"/"remove" keep the id of the part they change. Only refer to parts that exist BEFORE a feature.
        A figure with one entry in "parts" gives the part id = the feature id; with several, "<id>.0", "<id>.1" … in the order of its "parts" (their names and colours come from there).
        Part names and colours: optional "parts": {"<part id>": {"name": "Bracket", "color": "#9fb3c8"}}.

        ## Figures, mascots and free forms
        - Anything organic or character-like (a mascot of a club, an animal, a person, a monster, a toy, a fruit) is ONE figure feature, not sketches and extrudes.
        - Build it like a sculptor: big masses first (body, head), then limbs, ears, tail, then details (eyes, nose, mouth, buttons, a badge) as later parts in their colours.
          Use 10 to 60 blocks; proportions matter more than detail (a cute mascot: a big head, about 0.6–0.8 of the body width; short limbs; big eyes).
        - It stands on the Top plane: the lowest blocks (feet, a base) touch Z = 0, "flat": true. The front of the figure looks to -Y (the Front view), its left/right are ±X,
          symmetric about X = 0 unless the pose is not. Height about 60 mm unless asked (or the size of the other parts asks for another).
        - A picture of a mascot, figure or animal: rebuild its shape and colours this way (one part per main colour), as a 3D figure seen from the front.
        - A logo or emblem ON a figure (a club logo on the shirt or a base): extrude it from a sketch on a plane in front of the figure with op "add" into that part, or put it on a base plate.
        - To change a figure, answer with mode "patch" and the whole figure feature with the changed blocks (keep the id).
        Example (a bear, 56 mm): {"id":"ai_bear","type":"figure","name":"Bear","params":{"scale":"1","detail":"normal","flat":true,"parts":[
          {"name":"Fur","color":"#8b5a2b","smooth":3,"blocks":[{"t":"ellipsoid","c":[0,0,20],"r":[13,11,16]},{"t":"sphere","c":[0,-1,42],"r":11},
            {"t":"sphere","c":[-8,0,52],"r":4},{"t":"sphere","c":[8,0,52],"r":4},{"t":"capsule","a":[-11,-3,28],"b":[-15,-7,14],"r":4,"r2":3.5},
            {"t":"capsule","a":[11,-3,28],"b":[15,-7,14],"r":4,"r2":3.5},{"t":"capsule","a":[-6,-2,8],"b":[-7,-4,4],"r":5},{"t":"capsule","a":[6,-2,8],"b":[7,-4,4],"r":5},
            {"t":"ellipsoid","c":[-7,-6,2.5],"r":[5,7,2.5]},{"t":"ellipsoid","c":[7,-6,2.5],"r":[5,7,2.5]}]},
          {"name":"Belly","color":"#e8c39e","smooth":1,"blocks":[{"t":"ellipsoid","c":[0,-9,19],"r":[8,4,10]},{"t":"ellipsoid","c":[0,-10,40],"r":[5.5,3.5,4]}]},
          {"name":"Eyes","color":"#1d1d1b","smooth":0,"blocks":[{"t":"sphere","c":[-4,-10.3,45],"r":1.6},{"t":"sphere","c":[4,-10.3,45],"r":1.6},{"t":"sphere","c":[0,-13.3,41.5],"r":1.8}]}]}}

        ## Solids: never pieces inside each other
        - One physical part is ONE solid. Everything that is attached to it (a boss, a rib, a tab, a foot, a raised logo, a handle) is made with op "add" (it joins the part it
          touches and keeps its id) or joined with a boolean union – never as a second part ("new") stuck into the first.
        - Separate parts (a lid and its box, a figure on a base, a screw in a hole) may touch but must NEVER overlap. Where they fit into each other, cut the room for one out of the
          other (op "remove", or boolean subtract with keep) and leave a clearance (0.2 mm for 3D printing).
        - Do not leave tool bodies (cylinders for holes, construction bodies) as parts: use op "remove", or subtract them with a boolean.
        - The editor checks the parts after your answer and sends overlaps back to you for a repair.

        ## Quality and detail
        - Work like a designer: plan the part first (main body, attached features, cuts, holes, then fillets and chamfers LAST – they refer to the faces of the features
          before them). Use the whole feature set: revolve for round parts, shell for hollow housings, hole for screw holes, rib, draft, sweep, loft, thread, fillet, chamfer.
        - Realistic, consistent sizes and proportions; take every number the person gives exactly. Standard sizes (mm): clearance holes M3 3.4, M4 4.5, M5 5.5, M6 6.6,
          M8 9; counterbores M3 6.5 × 3.3, M4 8 × 4.4, M5 10 × 5.4, M6 11 × 6.4; tap drill M3 2.5, M4 3.3, M5 4.2, M6 5; walls of printed parts ≥ 1.6, of moulded ones 2–3.
        - Fillets: outer edges of handled parts 1–3, inner corners 0.5–1; chamfers on holes 0.5. Never a fillet larger than the thinnest wall next to it.
        - Name every feature clearly (in the language of the person) and give the parts names and fitting colours.

        ## Good practice
        - Holes and pockets: a sketch on the face plane (or a std plane) and extrude with op "remove" (end "through" for through-holes). Patterns of holes: sketch all circles in ONE sketch, or pattern a tool part and subtract it with boolean.
        - Round parts (shafts, knobs, bottles): a closed half-profile on the front plane right of the v-axis and revolve about "y".
        - Put a body on a face: a plane feature with the right offset, a sketch on it, extrude with op "add".
        - Keep the history short and readable, with clear names (in the language of the person). Do not repeat features that already exist; change them with mode "patch".

        ## Answer
        Exactly ONE JSON object, no Markdown:
        {"message": "what you did, in one to three sentences; name open questions", "mode": "append|patch|replace", "features": [ ... ], "remove": [ ... optional ... ], "parts": { ... optional ... }}
        - append: the features are added at the end (the usual case for something new)
        - patch: features with an existing id replace that feature in place; new ids are added at the end (to change or fix features)
        - replace: the whole list is replaced (only when the person asks to start over)
        - remove: ids of features to DELETE (works with every mode; "features" may then be []). Use it for features that are wrong, not needed, or that the person wants gone –
          yours from before as well – and delete the features that depend on them too (the extrude of a removed sketch, a fillet on a removed part). Suppressing is not deleting.
        If the request is not about modelling or cannot be done, answer with "features": [] and explain it in "message".
        Attachments: the person may attach pictures (photos, drawings, screenshots), PDFs or SVG files.
        - A picture of an object to rebuild: model it with the features above. Take sizes from the text or the picture (dimension lines, known parts like screws); where none are given,
          choose plausible ones and say which in "message". Rebuild the main shape first, then holes, pockets and patterns. A mascot, character, animal or other organic shape: a figure.
        - A logo, icon or lettering as a template: trace its outlines as closed sketch profiles (lines, arcs, circles; holes as inner profiles) on the Top plane, centred on the origin, about
          60 mm wide unless a size is asked for, then extrude them (for example a 2 mm base plate and the logo 1.5 mm raised on it with "op": "add"). From an SVG take the coordinates of
          its paths (flip y: SVG y points down), approximate curves with arcs or short lines.
        """;
}
