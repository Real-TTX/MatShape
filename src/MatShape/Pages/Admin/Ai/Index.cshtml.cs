using MatShape.Data;
using MatShape.Localization;
using MatShape.Services.Ai;
using Microsoft.AspNetCore.Mvc;

namespace MatShape.Pages.Admin.Ai;

/// <summary>The AI of the installation: on or off, the instruction of the site (added to the built-in one), the limits that keep the costs in check. Administrators only (checked again in <see cref="AiAdmin"/>).</summary>
public sealed class IndexModel(AppDbContext db) : AppPageModel
{
    [BindProperty] public bool Enabled { get; set; }

    [BindProperty] public string Instruction { get; set; } = string.Empty;

    [BindProperty] public int RepairRounds { get; set; }

    [BindProperty] public int UserDailyTokens { get; set; }

    [BindProperty] public int UserMonthlyTokens { get; set; }

    [BindProperty] public int MonthlyTokens { get; set; }

    [BindProperty] public int PerMinutePerAddress { get; set; }

    [BindProperty] public int MaxTokens { get; set; }

    [BindProperty] public int TimeoutSeconds { get; set; }

    public bool Available { get; private set; }

    public string? ActiveProfile { get; private set; }

    public int TokensThisMonth { get; private set; }

    public string FullInstruction { get; private set; } = string.Empty;

    private AiContext Context => new(db, HttpContext.RequestServices, UserId);

    public async Task<IActionResult> OnGetAsync()
    {
        if (await AiAdmin.SettingsAsync(Context) is not { } s)
        {
            return Forbid();
        }

        Enabled = s.Enabled;
        Instruction = s.Instruction;
        RepairRounds = s.RepairRounds;
        UserDailyTokens = s.UserDailyTokens;
        UserMonthlyTokens = s.UserMonthlyTokens;
        MonthlyTokens = s.MonthlyTokens;
        PerMinutePerAddress = s.PerMinutePerAddress;
        MaxTokens = s.MaxTokens;
        TimeoutSeconds = s.TimeoutSeconds;
        await LoadAsync(s);
        return Page();
    }

    public async Task<IActionResult> OnPostAsync()
    {
        var settings = new AiSettings
        {
            Enabled = Enabled,
            Instruction = Instruction,
            RepairRounds = RepairRounds,
            UserDailyTokens = UserDailyTokens,
            UserMonthlyTokens = UserMonthlyTokens,
            MonthlyTokens = MonthlyTokens,
            PerMinutePerAddress = PerMinutePerAddress,
            MaxTokens = MaxTokens,
            TimeoutSeconds = TimeoutSeconds,
        };
        if (!await AiAdmin.SaveSettingsAsync(Context, settings))
        {
            return Forbid();
        }

        Flash(Text.T("Common.Saved"));
        return LocalRedirect("/Admin/Ai");
    }

    private async Task LoadAsync(AiSettings s)
    {
        Available = await AiService.IsAvailableAsync(db, HttpContext.RequestServices);
        ActiveProfile = (await AiAdmin.ProfilesAsync(Context))?.FirstOrDefault(p => p.Profile.IsActive)?.Profile.Name;
        TokensThisMonth = (await AiAdmin.RunsAsync(Context, null, null, 1, 1))?.TokensThisMonth ?? 0;
        FullInstruction = ModelAssistant.SystemText(s, Languages.Current) + "\n\n[user]\n" + Text.T("Ai.SituationSketch");
    }
}
