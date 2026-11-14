namespace MatShape.Data;

/// <summary>What every record has: an Id (BIGINT) and who created and changed it, and when (the columns are filled by <see cref="AppDbContext"/>).</summary>
public abstract class Entity
{
    public long Id { get; set; }

    public DateTime CreateDate { get; set; }

    public long? CreateUserId { get; set; }

    public DateTime UpdateDate { get; set; }

    public long? UpdateUserId { get; set; }
}

/// <summary>A record that supports soft delete: 0 = deleted, 1 = created, 2 = updated. A deleted record is hidden by a query filter.</summary>
public abstract class SoftEntity : Entity
{
    public const short Deleted = 0;
    public const short Created = 1;
    public const short Updated = 2;

    public short UpdateState { get; set; } = Created;
}

public enum UserRole
{
    Admin = 1,
    User = 2,
}

/// <summary>What a person may do with a model they do not own. The owner may do everything.</summary>
public enum ModelRole
{
    /// <summary>No access.</summary>
    None = 0,

    /// <summary>May look at the model, measure and export.</summary>
    Viewer = 1,

    /// <summary>May change the Part Studios and create versions.</summary>
    Editor = 2,

    /// <summary>May also change the name, the members and the link, and delete the model.</summary>
    Owner = 3,
}

/// <summary>What a link to a model allows for anybody who has it. A link never edits: designs are changed by people with an account.</summary>
public enum LinkMode
{
    Off = 0,
    View = 1,
}

public sealed class User : SoftEntity
{
    /// <summary>The address to sign in with; unique, stored in lower case.</summary>
    public string Email { get; set; } = string.Empty;

    public string DisplayName { get; set; } = string.Empty;

    public string PasswordHash { get; set; } = string.Empty;

    public UserRole Role { get; set; } = UserRole.User;

    public bool IsActive { get; set; } = true;

    /// <summary>The IANA time zone dates are shown in.</summary>
    public string TimeZone { get; set; } = "Europe/Berlin";

    /// <summary>The language of the interface: en or de; empty = the language of the browser.</summary>
    public string Language { get; set; } = string.Empty;

    public int FailedLogins { get; set; }

    public DateTime? LockoutUntil { get; set; }

    public DateTime? LastLoginDate { get; set; }

    /// <summary>system, light or dark.</summary>
    public string Theme { get; set; } = "system";

    /// <summary>standard, paper, contrast or oled.</summary>
    public string Scheme { get; set; } = "standard";

    /// <summary>The unit new models start with: mm, cm, m or in.</summary>
    public string DefaultUnits { get; set; } = "mm";

    /// <summary>Mail about models that are shared with the person (only when the installation can send mail).</summary>
    public bool MailOnShare { get; set; } = true;

    /// <summary>The person of MatIdentity (the claim <c>sub</c>) this account is linked with; null = a local account only.</summary>
    public string? ExternalSubject { get; set; }
}

/// <summary>A signed-in browser. The cookie carries the <see cref="Token"/>; the session lives in the database.</summary>
public sealed class UserSession : Entity
{
    public Guid Token { get; set; } = Guid.NewGuid();

    public long UserId { get; set; }

    public User? User { get; set; }

    public DateTime LastSeenDate { get; set; }

    public DateTime ExpiresDate { get; set; }

    public bool IsRevoked { get; set; }

    public string? UserAgent { get; set; }

    public string? IpAddress { get; set; }

    /// <summary>The ID token of a sign-in through MatIdentity (for the sign-out there); null for a local sign-in. A secret: never exported.</summary>
    public string? IdentityToken { get; set; }

    /// <summary>The session of MatIdentity (the claim <c>sid</c>) this session started with: the back-channel logout ends it by this.</summary>
    public string? IdentitySessionId { get; set; }
}

/// <summary>A CAD model: a container of Part Studios (the tabs at the foot of the editor), shared as a whole.</summary>
public sealed class Model : SoftEntity
{
    public string Name { get; set; } = string.Empty;

    public string? Description { get; set; }

    public long OwnerId { get; set; }

    public User? Owner { get; set; }

    /// <summary>The unit a plain number means in the fields of the editor, and the unit of measurements: mm, cm, m or in.</summary>
    public string Units { get; set; } = "mm";

    /// <summary>A small picture of the model (PNG), made by the editor after a change; shown in the list.</summary>
    public byte[]? Thumbnail { get; set; }

    /// <summary>The secret of the link (<c>/s/&lt;token&gt;</c>); changing it ends every link that was given out.</summary>
    public Guid ShareToken { get; set; } = Guid.NewGuid();

    public LinkMode LinkMode { get; set; } = LinkMode.Off;

    /// <summary>The folder the owner put the model in; null = at the top. A member files it in a folder of their own (<see cref="ModelMember.FolderId"/>).</summary>
    public long? FolderId { get; set; }

    public Folder? Folder { get; set; }

    public ICollection<ModelMember> Members { get; set; } = [];

    public ICollection<PartStudio> Studios { get; set; } = [];
}

/// <summary>A person a model is shared with (the owner is not a member, they are <see cref="Model.OwnerId"/>).</summary>
public sealed class ModelMember : Entity
{
    public long ModelId { get; set; }

    public Model? Model { get; set; }

    public long UserId { get; set; }

    public User? User { get; set; }

    public ModelRole Role { get; set; } = ModelRole.Editor;

    /// <summary>The folder this person put the shared model in (a folder of their own); null = at the top.</summary>
    public long? FolderId { get; set; }

    public Folder? Folder { get; set; }
}

/// <summary>
/// A folder of one person, to give the list of models a structure: it holds models and other folders. Folders are private: everybody files the models they see (their own and
/// the ones shared with them) in folders of their own, so sharing a model never shows the folders of its owner. Deleting a folder deletes nothing in it: its models and folders
/// move up to where it was.
/// </summary>
public sealed class Folder : Entity
{
    public long OwnerId { get; set; }

    public User? Owner { get; set; }

    /// <summary>The folder it lies in; null = at the top.</summary>
    public long? ParentId { get; set; }

    public Folder? Parent { get; set; }

    public string Name { get; set; } = string.Empty;
}

/// <summary>
/// A Part Studio: the parametric history of a set of parts. <see cref="Content"/> is JSON: the ordered list of features (sketches, extrudes, revolves, booleans,
/// transforms, patterns, variables) and the names and colours of the parts. The geometry is made from it in the browser.
/// </summary>
public sealed class PartStudio : SoftEntity
{
    public long ModelId { get; set; }

    public Model? Model { get; set; }

    public string Name { get; set; } = string.Empty;

    /// <summary>The order of the tabs.</summary>
    public int Position { get; set; }

    public string Content { get; set; } = "{}";

    /// <summary>Counts every change: a browser that holds an older number knows its copy is old (it reloads instead of overwriting the work of another person).</summary>
    public long Revision { get; set; }
}

/// <summary>A named, unchangeable state of a whole model (every Part Studio), like a release. It can be opened read-only and restored.</summary>
public sealed class ModelVersion : Entity
{
    public long ModelId { get; set; }

    public Model? Model { get; set; }

    public string Name { get; set; } = string.Empty;

    public string? Description { get; set; }

    /// <summary>JSON: an array of the Part Studios at the time, each <c>{ "name": ..., "content": {...} }</c>.</summary>
    public string Content { get; set; } = "[]";
}

/// <summary>The few settings of the whole installation (one row, Id 1).</summary>
public sealed class SystemSetting : Entity
{
    /// <summary>Whether anyone may create an account. Closed until an administrator opens it (Administration → System): the first account of an installation can always
    /// sign up (it becomes the administrator), after it the administrators create the accounts.</summary>
    public bool RegistrationOpen { get; set; }

    /// <summary>The address the app is reached at from outside (for the links in mails); empty = the address of the request.</summary>
    public string? PublicUrl { get; set; }

    /// <summary>The settings of the AI (JSON: switched on, the instruction of the site, the limits); see <c>Services.Ai.AiSettings</c>.</summary>
    public string AiSettings { get; set; } = "{}";
}

// ---- AI ------------------------------------------------------------------------------------------------------------------------

public enum AiProvider
{
    /// <summary>Any server with the OpenAI-compatible /chat/completions (OpenAI, OpenRouter, Mistral, DeepSeek, an own server) and an API key.</summary>
    OpenAiCompatible = 0,

    /// <summary>A ChatGPT account, signed in with a device code (like Codex); the tokens are renewed by the app.</summary>
    ChatGpt = 1,
}

/// <summary>
/// A named connection to an AI ("OpenRouter free", "ChatGPT", "OpenAI"). Exactly one is active. The key or the sign-in is not in this row: it lies encrypted in the data volume
/// under <see cref="SecretToken"/>, outside the database, so it is never part of a backup and never sent to a browser.
/// </summary>
public sealed class AiProfile : SoftEntity
{
    public string Name { get; set; } = string.Empty;

    public AiProvider Provider { get; set; } = AiProvider.OpenAiCompatible;

    /// <summary>The template the address came from ("openai", "openrouter" ...), for the page only.</summary>
    public string? Preset { get; set; }

    public string BaseUrl { get; set; } = string.Empty;

    public string Model { get; set; } = string.Empty;

    public bool IsActive { get; set; }

    /// <summary>The name of the secret file of this profile (the key, or the ChatGPT sign-in). A copy of a profile gets a new one.</summary>
    public Guid SecretToken { get; set; } = Guid.NewGuid();

    public string? Note { get; set; }
}

public enum AiAction
{
    /// <summary>A test of a profile from the administration.</summary>
    Test = 0,

    /// <summary>The modelling assistant of the editor: a request becomes features of the Part Studio.</summary>
    Model = 1,

    /// <summary>3D generation: a picture, several views or a text become a mesh at a provider (Meshy); the run follows the task there.</summary>
    Mesh = 2,
}

public enum AiRunStatus
{
    Running = 0,
    Done = 1,
    LimitReached = 2,
    Stuck = 3,
    Error = 4,
    Cancelled = 5,
}

/// <summary>One call of the AI: what was asked, by whom, through which profile, what it cost and how it ended. The steps are in <see cref="AiRunStep"/>.</summary>
public sealed class AiRun : Entity
{
    public AiAction Action { get; set; }

    public AiRunStatus Status { get; set; } = AiRunStatus.Running;

    public long? ModelId { get; set; }

    public long? StudioId { get; set; }

    public long? UserId { get; set; }

    /// <summary>The brake per address: a hash of the address that changes every day, never the address.</summary>
    public string? AddressHash { get; set; }

    public string ProfileName { get; set; } = string.Empty;

    public string Model { get; set; } = string.Empty;

    public int PromptTokens { get; set; }

    public int CompletionTokens { get; set; }

    /// <summary>The provider gave no numbers: the tokens are estimated (characters / 4).</summary>
    public bool TokensEstimated { get; set; }

    public DateTime StartDate { get; set; }

    public DateTime? EndDate { get; set; }

    public string? Error { get; set; }

    /// <summary>What the person asked.</summary>
    public string? Prompt { get; set; }

    /// <summary>The checked answer (jsonb): the message and the features the editor applies.</summary>
    public string ResultJson { get; set; } = "{}";

    public List<AiRunStep> Steps { get; set; } = [];

    public int TotalTokens => PromptTokens + CompletionTokens;
}

public enum AiStepKind
{
    Message = 0,
    Result = 1,
    Warning = 2,
}

public sealed class AiRunStep : Entity
{
    public long AiRunId { get; set; }

    public AiRun? AiRun { get; set; }

    public int Number { get; set; }

    public AiStepKind Kind { get; set; }

    public string Text { get; set; } = string.Empty;

    public DateTime OccurredDate { get; set; }
}
