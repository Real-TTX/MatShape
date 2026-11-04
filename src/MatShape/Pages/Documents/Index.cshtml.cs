using MatShape.Data;
using MatShape.Localization;
using MatShape.Services;
using MatShape.Services.Documents;
using Microsoft.AspNetCore.Mvc;

namespace MatShape.Pages.Documents;

/// <summary>The documents of the signed-in person: their own and the ones shared with them, as pictures or as a table. Search, filter and sort are in the toolbar above.</summary>
public sealed class IndexModel(AppDbContext db) : AppPageModel
{
    private const int PageSize = 24;
    private static readonly string[] Sorts = ["changed", "name", "created"];

    public ToolbarModel Toolbar { get; private set; } = null!;

    public PagerModel Pager { get; private set; } = null!;

    public DocumentPage Listing { get; private set; } = new([], 0, 0);

    public string Zone => Me.TimeZone;

    public async Task OnGetAsync()
    {
        var search = ListQuery.Text(Request, "q");
        var scope = ListQuery.Text(Request, "scope") is "mine" or "shared" ? ListQuery.Text(Request, "scope") : null;
        var sort = ListQuery.Text(Request, "sort") is { } s && Sorts.Contains(s) ? s : "changed";
        var desc = ListQuery.Descending(Request, byDefault: sort != "name");
        var page = ListQuery.Page(Request);

        Listing = await DocumentService.ListAsync(db, UserId, new DocumentQuery(search, scope, sort, desc), page, PageSize);
        Toolbar = new ToolbarModel
        {
            Id = "documents",
            Action = "/Documents",
            Label = Text.T("Documents.Title"),
            Search = search,
            SearchField = true,
            SearchPlaceholder = Text.T("Documents.Search"),
            Filters = [new FilterField("scope", Text.T("Documents.Col.Owner"), [new("mine", Text.T("Documents.Mine")), new("shared", Text.T("Documents.Shared"))], scope)],
            SortOptions = [new("changed", Text.T("Documents.Col.Changed")), new("name", Text.T("Common.Name")), new("created", Text.T("Documents.Created"))],
            Sort = sort,
            Descending = desc,
            DefaultSort = "changed",
            DefaultDescending = true,
            Views = [new ViewOption("gallery", Text.T("Lists.View.Gallery"), "grid"), new ViewOption("list", Text.T("Lists.View.Table"), "list")],
            Total = Listing.Total,
            Matching = Listing.Matching,
            Noun = Text.T("Documents.Many"),
            NounOne = Text.T("Documents.One"),
        };
        Pager = new PagerModel { Page = page, PageSize = PageSize, Total = Listing.Matching, Url = Toolbar.UrlWithPage };
    }

    public async Task<IActionResult> OnPostDuplicateAsync(long id)
    {
        var copy = await DocumentService.DuplicateAsync(db, UserId, id, Text.T("Documents.CopyWord"));
        if (!copy.Ok)
        {
            return NotFound();
        }

        Flash(Text.T("Documents.Duplicated", copy.Value!.Name));
        return LocalRedirect($"/Documents/Studio/{copy.Value.Id}");
    }

    public async Task<IActionResult> OnPostLeaveAsync(long id)
    {
        if (!await DocumentService.RemoveMemberAsync(db, UserId, id, UserId))
        {
            return NotFound();
        }

        Flash(Text.T("Documents.Left"));
        return LocalRedirect("/Documents");
    }
}
