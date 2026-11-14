using MatShape.Data;

namespace MatShape.Services;

/// <summary>
/// What the page of the editor tells its scripts: which model, the role of the person, a version (read-only) and, for a link, its secret. <see cref="FolderId"/> is the
/// folder the person filed the model in (the back button returns there).
/// </summary>
public sealed record StudioViewModel(
    long ModelId, string Name, ModelRole Role, long? VersionId, string? LinkToken, bool IsGuest, string PersonName, bool AiAvailable = false, long? FolderId = null, bool MeshAvailable = false)
{
    public bool CanEdit => Role >= ModelRole.Editor && VersionId is null && LinkToken is null;

    public bool IsOwner => Role == ModelRole.Owner && LinkToken is null;

    /// <summary>The AI assistant is offered: the installation has one and the person may change the model.</summary>
    public bool ShowAi => AiAvailable && CanEdit;

    /// <summary>The 3D generation (Meshy) is offered: the installation has a key for it and the person may change the model.</summary>
    public bool ShowMesh => MeshAvailable && CanEdit;

    /// <summary>The dialog "AI 3D" is offered: through the AI of the installation (a figure of building blocks) and/or through Meshy.</summary>
    public bool ShowAi3d => ShowMesh || ShowAi;
}
