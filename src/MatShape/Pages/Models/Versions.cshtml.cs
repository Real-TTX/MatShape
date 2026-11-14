using MatShape.Data;
using MatShape.Localization;
using MatShape.Services;
using MatShape.Services.Models;
using Microsoft.AspNetCore.Mvc;

namespace MatShape.Pages.Models;

/// <summary>The versions of a model: everybody who sees the model sees them and can open them read-only; editors make, rename and restore them.</summary>
public sealed class VersionsModel(AppDbContext db) : AppPageModel
{
    private const int PageSize = 25;

    [BindProperty(SupportsGet = true)] public long Id { get; set; }

    public string ModelName { get; private set; } = string.Empty;

    public bool CanEdit { get; private set; }

    public bool IsOwner { get; private set; }

    public ToolbarModel Toolbar { get; private set; } = null!;

    public PagerModel Pager { get; private set; } = null!;

    public VersionPage Listing { get; private set; } = new([], 0, 0);

    public string Zone => Me.TimeZone;

    public async Task<IActionResult> OnGetAsync()
    {
        if (await ModelAccess.FindAsync(db, Actor.Of(UserId), Id) is not { } access)
        {
            return NotFound();
        }

        ModelName = access.Model.Name;
        CanEdit = access.CanEdit;
        IsOwner = access.IsOwner;

        var search = ListQuery.Text(Request, "q");
        var sort = ListQuery.Text(Request, "sort") == "name" ? "name" : "created";
        var desc = ListQuery.Descending(Request, byDefault: sort == "created");
        var page = ListQuery.Page(Request);
        Listing = await VersionService.ListAsync(db, Actor.Of(UserId), Id, new VersionQuery(search, sort, desc), page, PageSize) ?? new VersionPage([], 0, 0);
        Toolbar = new ToolbarModel
        {
            Id = "versions",
            Action = "/Models/Versions",
            Label = Text.T("Versions.Title"),
            Search = search,
            SearchField = true,
            SearchPlaceholder = Text.T("Versions.Search"),
            SortOptions = [new("created", Text.T("Versions.Col.Created")), new("name", Text.T("Common.Name"))],
            Sort = sort,
            Descending = desc,
            DefaultSort = "created",
            DefaultDescending = true,
            Keep = new Dictionary<string, string?> { ["id"] = Id.ToString(System.Globalization.CultureInfo.InvariantCulture) },
            Total = Listing.Total,
            Matching = Listing.Matching,
            Noun = Text.T("Versions.Many"),
            NounOne = Text.T("Versions.One"),
        };
        Pager = new PagerModel { Page = page, PageSize = PageSize, Total = Listing.Matching, Url = Toolbar.UrlWithPage };
        return Page();
    }

    public async Task<IActionResult> OnPostRestoreAsync(long versionId)
    {
        var restored = await VersionService.RestoreAsync(db, UserId, versionId, Text.T("Versions.BeforeRestore", Dates.Stamp(DateTime.UtcNow, Me.TimeZone)));
        if (restored.NotAllowed)
        {
            return NotFound();
        }

        if (!restored.Ok)
        {
            FlashError(restored.Error!);
            return LocalRedirect($"/Models/Versions?id={Id}");
        }

        Flash(Text.T("Versions.Restored"));
        return LocalRedirect($"/Models/Studio/{restored.Value}");
    }
}
