using System.Text.Json;

namespace MatShape.Services.Documents;

/// <summary>
/// The content of a Part Studio as the server sees it: JSON that the browser makes and reads. The server does not build geometry; it checks the shape of what is
/// stored (an object with a list of features of known types, sensible sizes) so that nothing else gets into the database, and it never puts any of it into a page as HTML.
/// <code>
/// { "features": [ { "id": "f1", "type": "sketch", "name": "Sketch 1", "suppressed": false, "params": { ... } }, ... ],
///   "parts": { "f2.0": { "name": "Bracket", "color": "#9fb4c8" } },
///   "rollback": null }
/// </code>
/// </summary>
public static class StudioContent
{
    public const string Empty = """{"features":[],"parts":{},"rollback":null}""";

    /// <summary>The largest content of one Part Studio (a long history of big sketches stays far below).</summary>
    public const int MaxBytes = 2_000_000;

    public const int MaxFeatures = 1000;

    /// <summary>The kinds of features the editor knows.</summary>
    public static readonly IReadOnlySet<string> FeatureTypes = new HashSet<string>(StringComparer.Ordinal)
    {
        "sketch", "plane", "extrude", "revolve", "boolean", "transform", "mirror", "lpattern", "cpattern", "split", "deletepart", "variable", "fillet", "chamfer", "hole", "shell", "rib", "sweep", "loft", "draft", "thread",
    };

    /// <summary>Checks a content; <c>null</c> when it is fine, else what is wrong (for the log and the answer of the API; the editor never sends such a thing).</summary>
    public static string? Validate(string? json)
    {
        if (string.IsNullOrEmpty(json))
        {
            return "empty";
        }

        if (System.Text.Encoding.UTF8.GetByteCount(json) > MaxBytes)
        {
            return "too large";
        }

        try
        {
            using var doc = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 32 });
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return "not an object";
            }

            if (!root.TryGetProperty("features", out var features) || features.ValueKind != JsonValueKind.Array)
            {
                return "no features";
            }

            if (features.GetArrayLength() > MaxFeatures)
            {
                return "too many features";
            }

            var ids = new HashSet<string>(StringComparer.Ordinal);
            foreach (var feature in features.EnumerateArray())
            {
                if (CheckFeature(feature, ids) is { } problem)
                {
                    return problem;
                }
            }

            if (root.TryGetProperty("parts", out var parts) && parts.ValueKind is not (JsonValueKind.Object or JsonValueKind.Null))
            {
                return "parts is not an object";
            }

            if (root.TryGetProperty("rollback", out var rollback) && rollback.ValueKind is not (JsonValueKind.Number or JsonValueKind.Null))
            {
                return "rollback is not a number";
            }

            return null;
        }
        catch (JsonException)
        {
            return "not JSON";
        }
    }

    /// <summary>How many features a content has (0 for anything that is not valid): for the numbers of the installation.</summary>
    public static int CountFeatures(string? json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json ?? "{}");
            return doc.RootElement.TryGetProperty("features", out var features) && features.ValueKind == JsonValueKind.Array ? features.GetArrayLength() : 0;
        }
        catch (JsonException)
        {
            return 0;
        }
    }

    private static string? CheckFeature(JsonElement feature, HashSet<string> ids)
    {
        if (feature.ValueKind != JsonValueKind.Object)
        {
            return "a feature is not an object";
        }

        if (!feature.TryGetProperty("id", out var id) || id.ValueKind != JsonValueKind.String || id.GetString() is not { Length: > 0 and <= 64 } idText)
        {
            return "a feature has no id";
        }

        if (!ids.Add(idText))
        {
            return $"the id {idText} is used twice";
        }

        if (!feature.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String || !FeatureTypes.Contains(type.GetString()!))
        {
            return $"the feature {idText} has an unknown type";
        }

        if (feature.TryGetProperty("name", out var name) && (name.ValueKind != JsonValueKind.String || name.GetString()!.Length > 120))
        {
            return $"the name of the feature {idText} is not valid";
        }

        if (feature.TryGetProperty("params", out var parameters) && parameters.ValueKind != JsonValueKind.Object)
        {
            return $"the parameters of the feature {idText} are not an object";
        }

        return null;
    }
}
