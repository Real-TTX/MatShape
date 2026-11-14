using MatShape.Controls;
using MatShape.Data;
using MatShape.Localization;
using MatShape.Services;
using MatShape.Services.Models;
using Microsoft.AspNetCore.Mvc;

namespace MatShape.Pages.Models;

/// <summary>
/// Files a model in a folder of the person – the way without dragging (keyboard, phone). Everybody who sees a model files it for themselves: the owner on the model, a member
/// on their membership.
/// </summary>
public sealed class MoveModel(AppDbContext db) : AppPageModel
{
    [BindProperty(SupportsGet = true)] public long Id { get; set; }

    /// <summary>The folder, as the choice sends it: empty = at the top.</summary>
    [BindProperty] public string Folder { get; set; } = string.Empty;

    public string Name { get; private set; } = string.Empty;

    public List<Choice> FolderChoices { get; private set; } = [];

    public string BackUrl { get; private set; } = "/Models";

    public async Task<IActionResult> OnGetAsync()
    {
        if (await ModelAccess.FindAsync(db, Actor.Of(UserId), Id) is not { } access)
        {
            return NotFound();
        }

        Name = access.Model.Name;
        var folder = await FolderService.FolderOfAsync(db, UserId, Id);
        Folder = folder?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty;
        BackUrl = folder is { } f ? $"/Models?folder={f}" : "/Models";
        var all = await FolderService.AllAsync(db, UserId);
        FolderChoices = [new Choice(string.Empty, Text.T("Folders.Top")), .. FolderService.Tree(all).Select(x => new Choice(x.Id.ToString(System.Globalization.CultureInfo.InvariantCulture), x.Label))];
        return Page();
    }

    public async Task<IActionResult> OnPostAsync()
    {
        long? target = long.TryParse(Folder, out var f) ? f : null;
        if (!await FolderService.FileAsync(db, UserId, Id, target))
        {
            return NotFound();
        }

        Flash(Text.T("Folders.Moved"));
        return LocalRedirect(target is { } t ? $"/Models?folder={t}" : "/Models");
    }
}
