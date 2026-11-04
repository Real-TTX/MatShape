using MatShape.Data;
using MatShape.Localization;
using MatShape.Services;
using MatShape.Services.Ai;
using Microsoft.AspNetCore.Mvc;

namespace MatShape.Pages.Admin.Ai.Runs;

/// <summary>Every call of the AI: who asked what, through which profile, what it cost and how it ended. Search and the status filter in the toolbar, the pager below.</summary>
public sealed class IndexModel(AppDbContext db) : AppPageModel
{
    private const int PageSize = 25;

    public ToolbarModel Toolbar { get; private set; } = null!;

    public PagerModel Pager { get; private set; } = null!;

    public AiAdmin.RunPage Listing { get; private set; } = new([], 0, 0, 0);

    public int TokensThisMonth => Listing.TokensThisMonth;

    public string Zone => Me.TimeZone;

    public async Task<IActionResult> OnGetAsync()
    {
        var search = ListQuery.Text(Request, "q");
        var status = Enum.TryParse<AiRunStatus>(ListQuery.Text(Request, "status"), out var s) ? s.ToString() : null;
        var page = ListQuery.Page(Request);
        if (await AiAdmin.RunsAsync(new AiContext(db, HttpContext.RequestServices, UserId), search, status, page, PageSize) is not { } listing)
        {
            return Forbid();
        }

        Listing = listing;
        Toolbar = new ToolbarModel
        {
            Id = "ai-runs",
            Action = "/Admin/Ai/Runs",
            Label = Text.T("Ai.Tab.Runs"),
            Search = search,
            SearchField = true,
            SearchPlaceholder = Text.T("Ai.Runs.Search"),
            Filters = [new FilterField("status", Text.T("Common.Status"), Enum.GetValues<AiRunStatus>().Select(x => new FilterOption(x.ToString(), Text.T("Ai.Status." + x))).ToList(), status)],
            Total = listing.Total,
            Matching = listing.Matching,
            Noun = Text.T("Ai.Runs.Many"),
            NounOne = Text.T("Ai.Runs.One"),
        };
        Pager = new PagerModel { Page = page, PageSize = PageSize, Total = listing.Matching, Url = Toolbar.UrlWithPage };
        return Page();
    }
}
