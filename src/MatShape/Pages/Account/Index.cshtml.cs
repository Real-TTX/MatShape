using MatShape.Controls;
using MatShape.Data;
using MatShape.Localization;
using MatShape.Services;
using MatShape.Services.Documents;
using MatShape.Services.Mail;
using Microsoft.AspNetCore.Mvc;
using MatShape.Services.Accounts;

namespace MatShape.Pages.Account;

/// <summary>The profile: name, language, time zone, the look, the unit of new documents and whether a mail comes when a document is shared. The theme button of the menu saves here too (handler Theme).</summary>
public sealed class IndexModel(AppDbContext db, MailService mail) : AppPageModel
{
    [BindProperty] public string DisplayName { get; set; } = string.Empty;

    [BindProperty] public string Language { get; set; } = string.Empty;

    [BindProperty] public string TimeZone { get; set; } = string.Empty;

    [BindProperty] public string DefaultUnits { get; set; } = DocumentUnits.Default;

    [BindProperty] public bool MailOnShare { get; set; } = true;

    [BindProperty] public string Scheme { get; set; } = "standard";

    public string Email { get; private set; } = string.Empty;

    public bool MailAvailable => mail.IsConfigured;

    public List<Choice> Zones { get; } = Dates.ZoneIds.Select(z => new Choice(z, z.Replace('_', ' '))).ToList();

    public List<Choice> LanguageChoices { get; } = [new(string.Empty, Text.T("Common.Language.Auto")), .. Languages.Supported.Select(l => new Choice(l.Code, l.Name))];

    public List<Choice> UnitChoices { get; } = DocumentUnits.All.Select(u => new Choice(u, Text.T("Units." + u))).ToList();

    public List<Choice> Schemes { get; } =
    [
        new("standard", Text.T("Settings.Scheme.Standard")), new("paper", Text.T("Settings.Scheme.Paper")),
        new("contrast", Text.T("Settings.Scheme.Contrast")), new("oled", Text.T("Settings.Scheme.Oled")),
    ];

    public async Task<IActionResult> OnGetAsync()
    {
        if (await Profiles.GetAsync(db, UserId, HttpContext.RequestAborted) is not { } user)
        {
            return NotFound();
        }

        DisplayName = user.DisplayName;
        Language = user.Language;
        TimeZone = user.TimeZone;
        DefaultUnits = user.DefaultUnits;
        MailOnShare = user.MailOnShare;
        Scheme = user.Scheme;
        Email = user.Email;
        return Page();
    }

    public async Task<IActionResult> OnPostAsync()
    {
        var input = new ProfileInput(DisplayName, Language, TimeZone, DefaultUnits, MailOnShare, Scheme);
        var (user, errors) = await Profiles.UpdateAsync(db, UserId, input, mail.IsConfigured, HttpContext.RequestAborted);
        if (user is null)
        {
            Email = (await Profiles.GetAsync(db, UserId))?.Email ?? string.Empty;
            errors.ForEach(e => ModelState.AddModelError(e.Field, e.Message));
            return Page();
        }

        if (user.Language.Length > 0)
        {
            Languages.SetCookie(Response, user.Language, Request.IsHttps);
        }
        else
        {
            Response.Cookies.Delete(Languages.CookieName);
        }

        SessionService.Invalidate();

        // the message is written in the language just chosen
        Flash(user.Language.Length > 0 ? Languages.In(user.Language, () => Text.T("Common.Saved")) : Text.T("Common.Saved"));
        return LocalRedirect("/Account");
    }

    /// <summary>The theme button of the menu (system, light, dark), saved per person.</summary>
    public async Task<IActionResult> OnPostThemeAsync(string theme)
    {
        if (await Profiles.SetThemeAsync(db, UserId, theme))
        {
            SessionService.Invalidate();
        }

        return new NoContentResult();
    }
}
