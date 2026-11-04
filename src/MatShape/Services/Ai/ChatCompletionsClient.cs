using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace MatShape.Services.Ai;

/// <summary>
/// One call to an OpenAI-compatible <c>/chat/completions</c> endpoint (OpenAI, Mistral, DeepSeek, OpenRouter, any compatible server) with an API
/// key: the one implementation of the traps below in MatShape. Never throws: failures come back as <c>Ok=false</c> with a reason.
/// <para>What providers differ in, learned per call: the name of the length cap (newer OpenAI models want
/// <c>max_completion_tokens</c>), whether they take a temperature (reasoning models do not), JSON mode, and pictures (DeepSeek
/// reads text only). A refusal that names one of these is retried without it — each switch flips once. An EMPTY answer is a
/// failure that says why: a reasoning model spends the length cap on thinking first, and a too-small cap used to come back as a
/// "successful" empty text. A short outage (network, HTTP 429, 5xx) is tried again after a growing pause (1, 2, 4 s).</para>
/// </summary>
public static class ChatCompletionsClient
{
    public const string DefaultBaseUrl = "https://api.openai.com/v1";

    public static async Task<AiResponse> CompleteAsync(HttpClient client, string baseUrl, string apiKey, string model, AiRequest req,
        int maxCompletionTokens, Action<string>? warn = null, CancellationToken ct = default, int timeoutSeconds = 280)
    {
        if (req.Messages is null || req.Messages.Count == 0) return new AiResponse { Ok = false, Error = "Leere KI-Anfrage." };
        baseUrl = (string.IsNullOrWhiteSpace(baseUrl) ? DefaultBaseUrl : baseUrl).Trim().TrimEnd('/');
        // Generous by default: a reasoning model spends the budget on thinking first and otherwise answers with nothing.
        var maxTokens = Math.Clamp(req.MaxTokens ?? maxCompletionTokens, 16, maxCompletionTokens);
        var transient = 0;
        var useCompletionTokens = false;
        var useTemperature = true;
        var useJson = req.Json;
        var useAttachments = req.Messages.Any(m => m.Attachments is { Count: > 0 });
        var useStream = req.OnDelta is not null;
        string? note = null;
        try
        {
            // AI completions routinely exceed a short timeout, and a reasoning model writing a whole page thinks first.
            client.Timeout = TimeSpan.FromSeconds(Math.Clamp(timeoutSeconds, 10, 900));
            for (var attempt = 0; attempt < 9; attempt++)
            {
                var payload = new JsonObject
                {
                    ["model"] = model,
                    ["messages"] = BuildMessages(req.Messages, useAttachments),
                    [useCompletionTokens ? "max_completion_tokens" : "max_tokens"] = maxTokens,
                };
                if (useTemperature) payload["temperature"] = 0.4;
                if (useJson) payload["response_format"] = new JsonObject { ["type"] = "json_object" };
                if (useStream)
                {
                    payload["stream"] = true;
                    payload["stream_options"] = new JsonObject { ["include_usage"] = true };
                }


                using var httpReq = new HttpRequestMessage(HttpMethod.Post, $"{baseUrl}/chat/completions");
                httpReq.Headers.Add("Authorization", $"Bearer {apiKey}");
                httpReq.Content = new StringContent(payload.ToJsonString(), Encoding.UTF8, "application/json");

                HttpResponseMessage resp;
                try
                {
                    resp = await client.SendAsync(httpReq, useStream ? HttpCompletionOption.ResponseHeadersRead : HttpCompletionOption.ResponseContentRead, ct);
                }
                catch (HttpRequestException ex) when (transient < 3)
                {
                    warn?.Invoke($"AI call failed transiently ({ex.Message}), trying again");
                    await Task.Delay(TimeSpan.FromSeconds(1 << transient++), ct);
                    continue;
                }

                using var _ = resp;
                if (resp.IsSuccessStatusCode && useStream && resp.Content.Headers.ContentType?.MediaType is { } mediaType && mediaType.Contains("event-stream", StringComparison.OrdinalIgnoreCase))
                {
                    // the answer arrives piece by piece; a stream that breaks off is a failure, never a half answer
                    var streamed = await ReadStreamAsync(resp, req.OnDelta!, ct);
                    if (streamed.Failure is not null)
                    {
                        warn?.Invoke("AI stream failed: " + streamed.Failure);
                        return new AiResponse { Ok = false, Model = model, PromptTokens = streamed.Prompt, CompletionTokens = streamed.Completion, Error = streamed.Failure };
                    }

                    return Finish(streamed.Text, streamed.Prompt, streamed.Completion, streamed.Finish, model, note);
                }

                var raw = await resp.Content.ReadAsStringAsync(ct);
                if (!resp.IsSuccessStatusCode)
                {
                    var status = (int)resp.StatusCode;
                    if ((status == 429 || status >= 500) && transient < 3)
                    {
                        warn?.Invoke($"AI call answered {status}, trying again");
                        await Task.Delay(TimeSpan.FromSeconds(1 << transient++), ct);
                        continue;
                    }

                    var why = ProviderError(raw);
                    var lower = why.ToLowerInvariant();
                    if (status is 400 or 422)
                    {
                        if (!useCompletionTokens && lower.Contains("max_tokens")) { useCompletionTokens = true; continue; }
                        if (useTemperature && lower.Contains("temperature")) { useTemperature = false; continue; }
                        if (useStream && lower.Contains("stream")) { useStream = false; continue; }
                        if (useJson && (lower.Contains("response_format") || lower.Contains("json"))) { useJson = false; continue; }
                        if (useAttachments && (lower.Contains("image") || lower.Contains("file") || lower.Contains("variant") || lower.Contains("content")))
                        {
                            useAttachments = false;
                            note = "Dieses Modell kann angehängte Bilder und PDFs nicht lesen – sie wurden weggelassen.";
                            continue;
                        }
                    }
                    warn?.Invoke($"AI call failed: {status} {Trunc(raw)}");
                    return new AiResponse
                    {
                        Ok = false, Model = model,
                        Error = status == 401 ? "Der API-Schlüssel wurde abgelehnt (HTTP 401)." : $"Anbieter-Fehler {status}: {why}",
                    };
                }

                using var doc = JsonDocument.Parse(raw);
                var root = doc.RootElement;
                var choice = root.GetProperty("choices")[0];
                var text = ContentText(choice.GetProperty("message"));
                var finish = choice.TryGetProperty("finish_reason", out var fr) && fr.ValueKind == JsonValueKind.String ? fr.GetString() : null;
                int prompt = 0, completion = 0;
                if (root.TryGetProperty("usage", out var usage))
                {
                    if (usage.TryGetProperty("prompt_tokens", out var p) && p.ValueKind == JsonValueKind.Number) prompt = p.GetInt32();
                    if (usage.TryGetProperty("completion_tokens", out var c) && c.ValueKind == JsonValueKind.Number) completion = c.GetInt32();
                }
                return Finish(text, prompt, completion, finish, model, note);
            }
            return new AiResponse { Ok = false, Error = "Der KI-Anbieter hat die Anfrage wiederholt abgelehnt.", Model = model };
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            warn?.Invoke("AI call threw: " + ex.Message);
            return new AiResponse
            {
                Ok = false, Model = model,
                Error = ex is TaskCanceledException ? "Die KI hat nicht rechtzeitig geantwortet." : $"KI-Aufruf fehlgeschlagen: {ex.Message}",
            };
        }
    }

    /// <summary>The answer of a call that came back with text (from one document or a stream): an empty text is a failure that says why, a cut-off one carries a note.</summary>
    private static AiResponse Finish(string text, int prompt, int completion, string? finish, string model, string? note)
    {
        if (string.IsNullOrWhiteSpace(text))
            return new AiResponse
            {
                Ok = false, PromptTokens = prompt, CompletionTokens = completion, Model = model,
                Error = finish == "length"
                    ? "Die KI hat ihr Längenlimit erreicht, bevor sie antworten konnte (bei Denk-Modellen zählt das Nachdenken mit)."
                    : "Die KI hat eine leere Antwort geliefert.",
            };
        if (finish == "length")
            note = (note is null ? "" : note + " ") + "Die Antwort wurde am Längenlimit abgeschnitten.";
        return new AiResponse { Ok = true, Text = text, PromptTokens = prompt, CompletionTokens = completion, Model = model, Note = note };
    }

    private sealed record Streamed(string Text, int Prompt, int Completion, string? Finish, string? Failure);

    /// <summary>
    /// Reads a chat-completions stream (server-sent events: <c>data: {chunk}</c> lines, <c>data: [DONE]</c> at the end) and hands every piece of text to <paramref name="onDelta"/>. A stream that ends
    /// before the provider said it was finished (a finish reason or <c>[DONE]</c>), or carries an error, is a failure: text that arrived before is never returned as if it were the whole answer.
    /// </summary>
    private static async Task<Streamed> ReadStreamAsync(HttpResponseMessage resp, Action<string> onDelta, CancellationToken ct)
    {
        await using var stream = await resp.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        var text = new StringBuilder();
        string? finish = null, failure = null;
        var done = false;
        int prompt = 0, completion = 0;

        string? line;
        while ((line = await reader.ReadLineAsync(ct)) is not null)
        {
            if (!line.StartsWith("data:", StringComparison.Ordinal)) continue;
            var data = line[5..].Trim();
            if (data.Length == 0) continue;
            if (data == "[DONE]") { done = true; break; }
            JsonDocument doc;
            try { doc = JsonDocument.Parse(data); } catch (JsonException) { continue; }
            using (doc)
            {
                var root = doc.RootElement;
                if (root.ValueKind != JsonValueKind.Object) continue;
                if (root.TryGetProperty("error", out var error) && error.ValueKind is JsonValueKind.Object or JsonValueKind.String)
                {
                    failure = "Anbieter-Fehler: " + (error.ValueKind == JsonValueKind.Object && error.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String ? m.GetString() : error.ValueKind == JsonValueKind.String ? error.GetString() : "unbekannt");
                    break;
                }

                if (root.TryGetProperty("usage", out var usage) && usage.ValueKind == JsonValueKind.Object)
                {
                    if (usage.TryGetProperty("prompt_tokens", out var p) && p.ValueKind == JsonValueKind.Number) prompt = p.GetInt32();
                    if (usage.TryGetProperty("completion_tokens", out var c) && c.ValueKind == JsonValueKind.Number) completion = c.GetInt32();
                }

                if (root.TryGetProperty("choices", out var choices) && choices.ValueKind == JsonValueKind.Array && choices.GetArrayLength() > 0)
                {
                    var choice = choices[0];
                    if (choice.TryGetProperty("delta", out var delta) && delta.ValueKind == JsonValueKind.Object && delta.TryGetProperty("content", out var content))
                    {
                        var piece = content.ValueKind == JsonValueKind.String ? content.GetString() : null;
                        if (!string.IsNullOrEmpty(piece))
                        {
                            text.Append(piece);
                            try { onDelta(piece); } catch (Exception) { /* a listener that fails must not break the call */ }
                        }
                    }

                    if (choice.TryGetProperty("finish_reason", out var fr) && fr.ValueKind == JsonValueKind.String) finish = fr.GetString();
                }
            }
        }

        if (failure is null && !done && finish is null) failure = "Die Antwort der KI wurde unterbrochen.";
        return new Streamed(text.ToString(), prompt, completion, finish, failure);
    }

    /// <summary>One model a provider offers. <c>Free</c>: it costs nothing per token (OpenRouter states prices — "0" for both, or an
    /// id ending in <c>:free</c>); a provider that states no prices is never guessed to be free.</summary>
    public sealed record ModelInfo(string Id, string Name, bool Free);

    /// <summary>The provider's <c>GET /models</c> — the list every OpenAI-compatible server answers (OpenAI, DeepSeek, OpenRouter's
    /// several hundred). Never throws: (null, reason) on failure.</summary>
    public static async Task<(List<ModelInfo>? models, string? error)> ListModelsAsync(HttpClient client, string baseUrl, string apiKey, CancellationToken ct = default)
    {
        baseUrl = (string.IsNullOrWhiteSpace(baseUrl) ? DefaultBaseUrl : baseUrl).Trim().TrimEnd('/');
        try
        {
            client.Timeout = TimeSpan.FromSeconds(30);
            using var req = new HttpRequestMessage(HttpMethod.Get, $"{baseUrl}/models");
            if (!string.IsNullOrWhiteSpace(apiKey)) req.Headers.Add("Authorization", $"Bearer {apiKey.Trim()}");
            using var resp = await client.SendAsync(req, ct);
            var raw = await resp.Content.ReadAsStringAsync(ct);
            if (!resp.IsSuccessStatusCode)
                return (null, (int)resp.StatusCode == 401 ? "Der API-Schlüssel wurde abgelehnt (HTTP 401)." : $"Anbieter-Fehler {(int)resp.StatusCode}: {ProviderError(raw)}");
            using var doc = JsonDocument.Parse(raw);
            if (!doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array)
                return (null, "Der Anbieter hat keine Modellliste geliefert.");
            var list = new List<ModelInfo>();
            foreach (var m in data.EnumerateArray())
            {
                if (!m.TryGetProperty("id", out var idEl) || idEl.ValueKind != JsonValueKind.String) continue;
                var id = idEl.GetString()!;
                var name = m.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String ? n.GetString()! : id;
                var free = id.EndsWith(":free", StringComparison.OrdinalIgnoreCase);
                if (!free && m.TryGetProperty("pricing", out var pr) && pr.ValueKind == JsonValueKind.Object)
                    free = IsZero(pr, "prompt") && IsZero(pr, "completion");
                list.Add(new ModelInfo(id, name, free));
            }
            return (list.OrderBy(x => x.Id, StringComparer.OrdinalIgnoreCase).ToList(), null);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            return (null, ex is TaskCanceledException ? "Der Anbieter hat nicht rechtzeitig geantwortet." : $"Modellliste nicht abrufbar: {ex.Message}");
        }

        static bool IsZero(JsonElement pricing, string name) =>
            pricing.TryGetProperty(name, out var v) && (v.ValueKind == JsonValueKind.String ? decimal.TryParse(v.GetString(),
                System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var d) && d == 0
                : v.ValueKind == JsonValueKind.Number && v.GetDecimal() == 0);
    }

    /// <summary>The messages in chat-completions form. A message with files becomes a list of parts (its text, then each picture as
    /// a data URL, each PDF as a file part); without, or with files switched off, it stays a plain string — the one shape every
    /// OpenAI-compatible provider understands. Switched off, a picture leaves a line saying it was there.</summary>
    public static JsonArray BuildMessages(IEnumerable<AiMessage> messages, bool withAttachments)
    {
        var arr = new JsonArray();
        foreach (var m in messages)
        {
            var role = m.Role is "system" or "assistant" ? m.Role : "user";
            var files = m.Attachments ?? new();
            if (files.Count == 0 || role != "user")
            {
                arr.Add(new JsonObject { ["role"] = role, ["content"] = m.Content ?? "" });
                continue;
            }
            if (!withAttachments)
            {
                var names = string.Join(", ", files.Select(f => f.Name));
                arr.Add(new JsonObject { ["role"] = role, ["content"] = (m.Content ?? "") + $"\n\n[Angehängt, für dieses Modell nicht lesbar: {names}]" });
                continue;
            }
            var parts = new JsonArray { new JsonObject { ["type"] = "text", ["text"] = m.Content ?? "" } };
            foreach (var f in files)
            {
                var dataUrl = $"data:{f.MediaType};base64,{f.Data}";
                parts.Add(f.Kind == "file"
                    ? new JsonObject { ["type"] = "file", ["file"] = new JsonObject { ["filename"] = f.Name, ["file_data"] = dataUrl } }
                    : new JsonObject { ["type"] = "image_url", ["image_url"] = new JsonObject { ["url"] = dataUrl } });
            }
            arr.Add(new JsonObject { ["role"] = role, ["content"] = parts });
        }
        return arr;
    }

    /// <summary>The answer text of a chat-completions message: a string, or (some providers) a list of parts.</summary>
    private static string ContentText(JsonElement message)
    {
        if (!message.TryGetProperty("content", out var c)) return "";
        if (c.ValueKind == JsonValueKind.String) return c.GetString() ?? "";
        if (c.ValueKind != JsonValueKind.Array) return "";
        var sb = new StringBuilder();
        foreach (var part in c.EnumerateArray())
            if (part.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String) sb.Append(t.GetString());
        return sb.ToString();
    }

    private static string Trunc(string s) => s.Length > 600 ? s[..600] : s;

    private static string ProviderError(string raw)
    {
        try
        {
            using var d = JsonDocument.Parse(raw);
            if (d.RootElement.TryGetProperty("error", out var e) && e.ValueKind == JsonValueKind.Object && e.TryGetProperty("message", out var m))
                return m.GetString() ?? "";
        }
        catch (JsonException) { /* not JSON */ }
        return Trunc(raw);
    }
}
