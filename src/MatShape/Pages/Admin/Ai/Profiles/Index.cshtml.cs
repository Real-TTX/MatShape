using MatShape.Data;
using MatShape.Localization;
using MatShape.Services;
using MatShape.Services.Ai;
using Microsoft.AspNetCore.Mvc;

namespace MatShape.Pages.Admin.Ai.Profiles;

/// <summary>The AI profiles: named connections (OpenAI, OpenRouter, a ChatGPT account ...), exactly one active. Search and filter in the toolbar.</summary>
public sealed class IndexModel(AppDbContext db) : AppPageModel
{
    public IReadOnlyList<AiProfileRow> Rows { get; private set; } = [];

    public int Total { get; private set; }

    public ToolbarModel Toolbar { get; private set; } = null!;

    private AiContext Context => new(db, HttpContext.RequestServices, UserId);

    public async Task<IActionResult> OnGetAsync()
    {
        if (await AiAdmin.ProfilesAsync(Context) is not { } all)
        {
            return Forbid();
        }

        var search = ListQuery.Text(Request, "q");
        var kind = ListQuery.Text(Request, "kind") is "OpenAiCompatible" or "ChatGpt" ? ListQuery.Text(Request, "kind") : null;
        Total = all.Count;
        Rows = all
            .Where(r => string.IsNullOrWhiteSpace(search) || r.Profile.Name.Contains(search, StringComparison.CurrentCultureIgnoreCase) || r.Profile.Model.Contains(search, StringComparison.OrdinalIgnoreCase))
            .Where(r => kind is null || r.Profile.Provider.ToString() == kind)
            .ToList();
        Toolbar = new ToolbarModel
        {
            Id = "ai-profiles",
            Action = "/Admin/Ai/Profiles",
            Label = Text.T("Ai.Tab.Profiles"),
            Search = search,
            SearchField = true,
            SearchPlaceholder = Text.T("Ai.Profiles.Search"),
            Filters = [new FilterField("kind", Text.T("Ai.Profile.Provider"), [new("OpenAiCompatible", Text.T("Ai.Provider.OpenAiCompatible")), new("ChatGpt", Text.T("Ai.Provider.ChatGpt"))], kind)],
            Total = Total,
            Matching = Rows.Count,
            Noun = Text.T("Ai.Profiles.Many"),
            NounOne = Text.T("Ai.Profiles.One"),
        };
        return Page();
    }

    public async Task<IActionResult> OnPostActivateAsync(long id)
    {
        if (!await AiAdmin.ActivateAsync(Context, id))
        {
            return NotFound();
        }

        Flash(Text.T("Ai.Profile.Activated"));
        return LocalRedirect("/Admin/Ai/Profiles");
    }

    public async Task<IActionResult> OnPostDuplicateAsync(long id)
    {
        if (await AiAdmin.DuplicateAsync(Context, id, Text.T("Models.CopyWord")) is not { } copy)
        {
            return NotFound();
        }

        Flash(Text.T("Common.CreatedNamed", copy.Name));
        return LocalRedirect($"/Admin/Ai/Profiles/Edit?id={copy.Id}");
    }
}
