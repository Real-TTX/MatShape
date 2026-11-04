using System.Text.Json;

namespace MatShape.Services.Ai;

/// <summary>
/// Reads the one JSON object a model was asked for, forgivingly: inside a ``` fence, after a sentence of introduction, with trailing commas
/// or comments. Works with every model, unlike provider-specific tool calls. What the object MEANS is checked by the caller, never trusted.
/// </summary>
public static class LenientJson
{
    private static readonly JsonDocumentOptions Options = new()
    {
        AllowTrailingCommas = true,
        CommentHandling = JsonCommentHandling.Skip,
        MaxDepth = 32,
    };

    /// <summary>The first complete JSON object in <paramref name="text"/>, or null.</summary>
    public static JsonElement? FirstObject(string? text) => Objects(text).Select(o => (JsonElement?)o).FirstOrDefault();

    /// <summary>
    /// Every complete JSON object in <paramref name="text"/>, in the order their opening braces come (an object inside another one is found after it, too): a model that writes a sentence with
    /// a brace in it before the real answer is still read.
    /// </summary>
    public static IEnumerable<JsonElement> Objects(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            yield break;
        }

        var start = text.IndexOf('{');
        while (start >= 0)
        {
            var end = MatchingBrace(text, start);
            if (end > start)
            {
                JsonElement? found = null;
                try
                {
                    using var doc = JsonDocument.Parse(text.AsMemory(start, end - start + 1), Options);
                    if (doc.RootElement.ValueKind == JsonValueKind.Object)
                    {
                        found = doc.RootElement.Clone();
                    }
                }
                catch (JsonException)
                {
                    // Not this one: try the next opening brace.
                }

                if (found is { } element)
                {
                    yield return element;
                }
            }

            start = text.IndexOf('{', start + 1);
        }
    }

    /// <summary>The closing brace of the object that starts at <paramref name="start"/>, aware of strings and escapes; -1 when it does not close.</summary>
    private static int MatchingBrace(string text, int start)
    {
        var depth = 0;
        var inString = false;
        for (var i = start; i < text.Length; i++)
        {
            var c = text[i];
            if (inString)
            {
                if (c == '\\')
                {
                    i++;
                }
                else if (c == '"')
                {
                    inString = false;
                }

                continue;
            }

            switch (c)
            {
                case '"':
                    inString = true;
                    break;
                case '{':
                    depth++;
                    break;
                case '}':
                    depth--;
                    if (depth == 0)
                    {
                        return i;
                    }

                    break;
            }
        }

        return -1;
    }

    public static string? Text(this JsonElement o, string name)
        => o.ValueKind == JsonValueKind.Object && o.TryGetProperty(name, out var v)
            ? v.ValueKind switch
            {
                JsonValueKind.String => v.GetString(),
                JsonValueKind.Number => v.GetRawText(),
                JsonValueKind.True => "true",
                JsonValueKind.False => "false",
                _ => null,
            }
            : null;

    public static long? Long(this JsonElement o, string name)
        => long.TryParse(o.Text(name), System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var v) ? v : null;

    public static double? Double(this JsonElement o, string name)
        => double.TryParse(o.Text(name), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var v) ? v : null;

    public static bool? Bool(this JsonElement o, string name)
        => o.Text(name)?.ToLowerInvariant() switch
        {
            "true" or "yes" or "ja" or "1" => true,
            "false" or "no" or "nein" or "0" => false,
            _ => null,
        };
}
