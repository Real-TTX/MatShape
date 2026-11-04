using MatShape.Data;

namespace MatShape.Services;

/// <summary>What the page of the editor tells its scripts: which document, the role of the person, a version (read-only) and, for a link, its secret.</summary>
public sealed record StudioViewModel(long DocumentId, string Name, DocumentRole Role, long? VersionId, string? LinkToken, bool IsGuest, string PersonName, bool AiAvailable = false)
{
    public bool CanEdit => Role >= DocumentRole.Editor && VersionId is null && LinkToken is null;

    public bool IsOwner => Role == DocumentRole.Owner && LinkToken is null;

    /// <summary>The AI assistant is offered: the installation has one and the person may change the document.</summary>
    public bool ShowAi => AiAvailable && CanEdit;
}
