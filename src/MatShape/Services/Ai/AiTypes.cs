namespace MatShape.Services.Ai;

/// <summary>One message of a chat with a model.</summary>
public sealed class AiMessage
{
    /// <summary>"system" | "user" | "assistant".</summary>
    public string Role { get; set; } = "user";

    public string Content { get; set; } = "";

    /// <summary>Files that ride along with a user message (pictures, PDFs); empty for nearly every message.</summary>
    public List<AiAttachment> Attachments { get; set; } = [];

    public static AiMessage System(string text) => new() { Role = "system", Content = text };

    public static AiMessage User(string text) => new() { Role = "user", Content = text };

    public static AiMessage Assistant(string text) => new() { Role = "assistant", Content = text };
}

/// <summary>One file attached to an <see cref="AiMessage"/>, inline as base64.</summary>
public sealed class AiAttachment
{
    /// <summary>"image" | "file".</summary>
    public string Kind { get; set; } = "image";

    public string MediaType { get; set; } = "";

    public string Name { get; set; } = "";

    public string Data { get; set; } = "";
}

/// <summary>What is asked of a model: the messages, a length cap and whether the answer must be one JSON object.</summary>
public sealed class AiRequest
{
    public List<AiMessage> Messages { get; set; } = [];

    public int? MaxTokens { get; set; }

    public bool Json { get; set; }

    /// <summary>
    /// Asks for the answer as a stream: called with every piece of text as the provider writes it (from whatever thread reads the stream). A provider that cannot stream is asked again
    /// without it (the callback then never fires and the whole answer arrives at once); the caller must not rely on it being called. The returned <see cref="AiResponse"/> is complete either way.
    /// </summary>
    public Action<string>? OnDelta { get; set; }
}

/// <summary>The answer. <c>Ok=false</c> carries a reason a person can read; an empty answer is never <c>Ok</c>.</summary>
public sealed class AiResponse
{
    public bool Ok { get; set; }

    public string? Text { get; set; }

    public string? Error { get; set; }

    public int PromptTokens { get; set; }

    public int CompletionTokens { get; set; }

    public string? Model { get; set; }

    public string? Note { get; set; }
}

/// <summary>The rough cost of a text when the provider gives no numbers: characters divided by four.</summary>
public static class TokenEstimate
{
    public static int Of(string? text) => string.IsNullOrEmpty(text) ? 0 : (text.Length + 3) / 4;

    public static int Of(IEnumerable<AiMessage> messages) => messages.Sum(m => Of(m.Content));
}
