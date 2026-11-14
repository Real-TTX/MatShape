using MatShape.Data;
using MatShape.Localization;
using MatShape.Services;
using MatShape.Services.Models;
using Microsoft.AspNetCore.Mvc;

namespace MatShape.Pages.Models;

/// <summary>
/// The models of the signed-in person: their own and the ones shared with them, as pictures or as a table, in folders of their own (<c>?folder=</c>; the folders of the
/// open folder stand above the models). Search, filter and sort are in the toolbar above; a search or a filter looks through every folder. Models and folders are filed
/// by dragging them onto a folder or onto a folder of the path above (folders.js posts the handler Drop), or with the action "Move".
/// </summary>
public sealed class IndexModel(AppDbContext db) : AppPageModel
{
    private const int PageSize = 24;
    private static readonly string[] Sorts = ["changed", "name", "created"];

    public ToolbarModel Toolbar { get; private set; } = null!;

    public PagerModel Pager { get; private set; } = null!;

    public ModelPage Listing { get; private set; } = new([], 0, 0);

    /// <summary>The folders shown above the models: the ones in the open folder, or – while searching – the ones whose name matches.</summary>
    public IReadOnlyList<FolderTile> Folders { get; private set; } = [];

    /// <summary>The open folder from the top down (empty = the top).</summary>
    public IReadOnlyList<FolderRow> Path { get; private set; } = [];

    public long? Folder => Path.Count > 0 ? Path[^1].Id : null;

    public bool Browsing { get; private set; }

    public string Zone => Me.TimeZone;

    /// <summary>The address of this list (for the way back after a drop).</summary>
    public string Here => Request.Path + Request.QueryString;

    public async Task<IActionResult> OnGetAsync()
    {
        var search = ListQuery.Text(Request, "q");
        var scope = ListQuery.Text(Request, "scope") is "mine" or "shared" ? ListQuery.Text(Request, "scope") : null;
        var sort = ListQuery.Text(Request, "sort") is { } s && Sorts.Contains(s) ? s : "changed";
        var desc = ListQuery.Descending(Request, byDefault: sort != "name");
        var page = ListQuery.Page(Request);

        long? folder = long.TryParse(Request.Query["folder"], out var f) ? f : null;
        var all = await FolderService.AllAsync(db, UserId);
        Path = FolderService.PathOf(all, folder);
        if (folder is not null && Path.Count == 0)
        {
            // a folder that is gone (or was never theirs): the top
            return LocalRedirect("/Models");
        }

        var query = new ModelQuery(search, scope, sort, desc, Folder);
        Browsing = query.Browsing;
        Listing = await ModelService.ListAsync(db, UserId, query, page, PageSize);
        if ((Browsing || search is not null) && scope != "shared")
        {
            Folders = await FolderService.ChildrenAsync(db, UserId, Folder, Browsing ? null : search);
        }

        Toolbar = new ToolbarModel
        {
            Id = "models",
            Action = "/Models",
            Label = Text.T("Models.Title"),
            Search = search,
            SearchField = true,
            SearchPlaceholder = Text.T("Models.Search"),
            Filters = [new FilterField("scope", Text.T("Models.Col.Owner"), [new("mine", Text.T("Models.Mine")), new("shared", Text.T("Models.Shared"))], scope)],
            SortOptions = [new("changed", Text.T("Models.Col.Changed")), new("name", Text.T("Common.Name")), new("created", Text.T("Models.Created"))],
            Sort = sort,
            Descending = desc,
            DefaultSort = "changed",
            DefaultDescending = true,
            Views = [new ViewOption("gallery", Text.T("Lists.View.Gallery"), "grid"), new ViewOption("list", Text.T("Lists.View.Table"), "list")],
            // browsing, the count is the one of the open folder (not "1 of 81", which reads like a filter)
            Total = Browsing ? Listing.Matching : Listing.Total,
            Matching = Listing.Matching,
            Noun = Text.T("Models.Many"),
            NounOne = Text.T("Models.One"),
            Keep = Browsing && Folder is { } open ? new Dictionary<string, string?> { ["folder"] = open.ToString(System.Globalization.CultureInfo.InvariantCulture) } : new Dictionary<string, string?>(),
        };
        Pager = new PagerModel { Page = page, PageSize = PageSize, Total = Listing.Matching, Url = Toolbar.UrlWithPage };
        return Page();
    }

    /// <summary>"3 models · 1 folder", or "Empty".</summary>
    public static string Contents(FolderTile f)
    {
        var parts = new List<string>();
        if (f.Models > 0)
        {
            parts.Add(f.Models == 1 ? Text.T("Folders.OneModel") : Text.T("Folders.ManyModels", f.Models));
        }

        if (f.Folders > 0)
        {
            parts.Add(f.Folders == 1 ? Text.T("Folders.OneFolder") : Text.T("Folders.ManyFolders", f.Folders));
        }

        return parts.Count == 0 ? Text.T("Folders.Empty") : string.Join(" · ", parts);
    }

    public async Task<IActionResult> OnPostDuplicateAsync(long id)
    {
        var copy = await ModelService.DuplicateAsync(db, UserId, id, Text.T("Models.CopyWord"));
        if (!copy.Ok)
        {
            return NotFound();
        }

        Flash(Text.T("Models.Duplicated", copy.Value!.Name));
        return LocalRedirect($"/Models/Studio/{copy.Value.Id}");
    }

    public async Task<IActionResult> OnPostLeaveAsync(long id)
    {
        if (!await ModelService.RemoveMemberAsync(db, UserId, id, UserId))
        {
            return NotFound();
        }

        Flash(Text.T("Models.Left"));
        return LocalRedirect("/Models");
    }

    /// <summary>A model or a folder dropped onto a folder (<paramref name="target"/> empty = the top). Sent by folders.js; the list is shown again.</summary>
    public async Task<IActionResult> OnPostDropAsync(string kind, long id, string? target, string? back)
    {
        long? into = long.TryParse(target, out var t) ? t : null;
        var to = Url.IsLocalUrl(back) ? back! : "/Models";
        if (kind == "folder")
        {
            if (into == id)
            {
                return LocalRedirect(to);
            }

            var moved = await FolderService.MoveAsync(db, UserId, id, into);
            if (moved.NotAllowed)
            {
                return NotFound();
            }

            if (!moved.Ok)
            {
                FlashError(moved.Error!);
                return LocalRedirect(to);
            }
        }
        else if (!await FolderService.FileAsync(db, UserId, id, into))
        {
            return NotFound();
        }

        Flash(Text.T("Folders.Moved"));
        return LocalRedirect(to);
    }
}
