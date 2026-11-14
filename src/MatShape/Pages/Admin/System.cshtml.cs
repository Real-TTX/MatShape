using MatShape.Localization;
using MatShape.Services;
using MatShape.Services.Mail;
using Microsoft.AspNetCore.Mvc;

namespace MatShape.Pages.Admin;

/// <summary>
/// The settings of the installation (registration, public address) and what is in it; the same values as the platform API (<see cref="InstanceService"/>).
/// An address that <c>MAT_PUBLIC_URL</c> sets is shown read-only.
/// </summary>
public sealed class SystemModel(InstanceService instance, MailService mail) : AppPageModel
{
    [BindProperty] public bool RegistrationOpen { get; set; }

    [BindProperty] public string PublicUrl { get; set; } = string.Empty;

    /// <summary><c>MAT_PUBLIC_URL</c> sets the public address.</summary>
    public bool PublicUrlFixed => instance.PublicUrlFixed;

    public InstanceSnapshot Counts { get; private set; } = null!;

    public string Database { get; private set; } = string.Empty;

    /// <summary>Where the mail goes (MatSMTP), or null when the installation sends none.</summary>
    public string? MailText => mail.Describe(Languages.Current);

    public async Task OnGetAsync()
    {
        var (open, url) = await instance.SettingsAsync();
        RegistrationOpen = open;
        PublicUrl = url ?? string.Empty;
        await LoadAsync();
    }

    public async Task<IActionResult> OnPostAsync()
    {
        // a fixed address is not posted (the field is read-only) and stays as it is
        if (await instance.SaveSettingsAsync(RegistrationOpen, PublicUrl) is { } problem)
        {
            ModelState.AddModelError(nameof(PublicUrl), problem);
            await LoadAsync();
            return Page();
        }

        Flash(Text.T("Common.Saved"));
        return LocalRedirect("/Admin/System");
    }

    private async Task LoadAsync()
    {
        if (PublicUrlFixed)
        {
            PublicUrl = (await instance.SettingsAsync()).PublicUrl ?? string.Empty;
        }

        Counts = await instance.SnapshotAsync();
        Database = instance.DatabaseName();
    }
}
