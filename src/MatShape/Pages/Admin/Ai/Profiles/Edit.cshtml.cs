using MatShape.Controls;
using MatShape.Data;
using MatShape.Localization;
using MatShape.Services.Ai;
using Microsoft.AspNetCore.Mvc;

namespace MatShape.Pages.Admin.Ai.Profiles;

/// <summary>
/// One AI profile: an OpenAI-compatible provider (OpenAI, OpenRouter with its free models, Mistral, DeepSeek, an own server) with an API key, or a ChatGPT account signed in with a device code.
/// Save, Back, Test, Activate, then Delete at a distance. Administrators only (checked again in <see cref="AiAdmin"/>).
/// </summary>
public sealed class EditModel(AppDbContext db) : AppPageModel
{
    [BindProperty(SupportsGet = true)] public long? Id { get; set; }

    [BindProperty] public string Name { get; set; } = string.Empty;

    [BindProperty] public string Provider { get; set; } = nameof(AiProvider.OpenAiCompatible);

    [BindProperty] public string? Preset { get; set; } = "openrouter";

    [BindProperty] public string BaseUrl { get; set; } = "https://openrouter.ai/api/v1";

    [BindProperty] public string ApiKey { get; set; } = string.Empty;

    [BindProperty] public bool RemoveKey { get; set; }

    [BindProperty] public string Model { get; set; } = string.Empty;

    [BindProperty] public string Note { get; set; } = string.Empty;

    public bool IsNew => Id is null;

    public bool IsActive { get; private set; }

    public bool HasKey { get; private set; }

    public string? TestResult { get; private set; }

    public bool TestOk { get; private set; }

    public ChatGptAccount.Status? ChatGpt { get; private set; }

    public List<Choice> Providers { get; } =
    [
        new(nameof(AiProvider.OpenAiCompatible), Text.T("Ai.Provider.OpenAiCompatible"), Text.T("Ai.Provider.OpenAiCompatible.Hint")),
        new(nameof(AiProvider.ChatGpt), Text.T("Ai.Provider.ChatGpt"), Text.T("Ai.Provider.ChatGpt.Hint")),
    ];

    private AiContext Context => new(db, HttpContext.RequestServices, UserId);

    public async Task<IActionResult> OnGetAsync()
    {
        if (Id is null)
        {
            return await AiAdmin.SettingsAsync(Context) is null ? Forbid() : Page();
        }

        return await LoadAsync(fillForm: true) ? Page() : NotFound();
    }

    public async Task<IActionResult> OnPostAsync()
    {
        var provider = Enum.TryParse<AiProvider>(Provider, out var p) ? p : AiProvider.OpenAiCompatible;
        var (saved, errors, denied) = await AiAdmin.SaveAsync(Context, Id, new AiProfileInput(Name, provider, Preset, BaseUrl, Model, ApiKey, RemoveKey, Note));
        if (denied)
        {
            return NotFound();
        }

        if (saved is null)
        {
            errors.ForEach(e => ModelState.AddModelError(e.Field, e.Message));
            if (Id is not null)
            {
                await LoadAsync(fillForm: false);
            }

            return Page();
        }

        Flash(Text.T("Common.Saved"));
        return LocalRedirect($"/Admin/Ai/Profiles/Edit?id={saved.Id}");
    }

    public async Task<IActionResult> OnPostTestAsync()
    {
        if (Id is not { } id || !await LoadAsync(fillForm: true))
        {
            return NotFound();
        }

        var test = await AiService.TestAsync(Context, id, HttpContext.Connection.RemoteIpAddress?.ToString());
        TestResult = test?.Text;
        TestOk = test?.Ok == true;
        return Page();
    }

    public async Task<IActionResult> OnPostActivateAsync()
    {
        if (Id is not { } id || !await AiAdmin.ActivateAsync(Context, id))
        {
            return NotFound();
        }

        Flash(Text.T("Ai.Profile.Activated"));
        return LocalRedirect($"/Admin/Ai/Profiles/Edit?id={id}");
    }

    public async Task<IActionResult> OnPostDeleteAsync()
    {
        if (Id is not { } id || !await AiAdmin.DeleteAsync(Context, id))
        {
            return NotFound();
        }

        Flash(Text.T("Common.DeletedNamed", Name));
        return LocalRedirect("/Admin/Ai/Profiles");
    }

    public async Task<IActionResult> OnPostChatGptStartAsync()
    {
        if (Id is not { } id || await AiAdmin.StartChatGptLoginAsync(Context, id) is not { } started)
        {
            return NotFound();
        }

        if (started.Error is { } error)
        {
            FlashError(error);
        }

        return LocalRedirect($"/Admin/Ai/Profiles/Edit?id={id}");
    }

    public async Task<IActionResult> OnPostChatGptLogoutAsync()
    {
        if (Id is not { } id || !await AiAdmin.ChatGptLogoutAsync(Context, id))
        {
            return NotFound();
        }

        Flash(Text.T("Ai.ChatGpt.LoggedOut"));
        return LocalRedirect($"/Admin/Ai/Profiles/Edit?id={id}");
    }

    private async Task<bool> LoadAsync(bool fillForm)
    {
        if (Id is not { } id || await AiAdmin.ProfileAsync(Context, id) is not { } row)
        {
            return false;
        }

        var profile = row.Profile;
        IsActive = profile.IsActive;
        HasKey = row.HasSecret;
        if (fillForm)
        {
            Name = profile.Name;
            Provider = profile.Provider.ToString();
            Preset = profile.Preset ?? "custom";
            BaseUrl = profile.BaseUrl;
            Model = profile.Model;
            Note = profile.Note ?? string.Empty;
        }

        if (profile.Provider == AiProvider.ChatGpt)
        {
            ChatGpt = await AiAdmin.ChatGptStatusAsync(Context, id, poll: false);
        }

        return true;
    }
}
