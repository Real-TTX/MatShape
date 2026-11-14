using MatShape.Controls;
using MatShape.Data;
using MatShape.Localization;
using MatShape.Services;
using MatShape.Services.Models;
using Microsoft.AspNetCore.Mvc;

namespace MatShape.Pages.Models;

/// <summary>
/// Create a folder (<c>?parent=</c> = in which), rename it, put it into another folder, delete it. A folder belongs to one person; deleting it deletes nothing in it:
/// its models and folders move up to where it was (FolderService).
/// </summary>
public sealed class FolderModel(AppDbContext db) : AppPageModel
{
    [BindProperty(SupportsGet = true)] public long? Id { get; set; }

    [BindProperty] public string Name { get; set; } = string.Empty;

    /// <summary>The folder it lies in, as the choice sends it: empty = at the top.</summary>
    [BindProperty] public string Parent { get; set; } = string.Empty;

    public bool IsNew => Id is null;

    public List<Choice> ParentChoices { get; private set; } = [];

    /// <summary>Where Back goes: the folder itself, or – for a new one – the folder it is made in.</summary>
    public string BackUrl => Id is { } id ? $"/Models?folder={id}" : ParentId is { } p ? $"/Models?folder={p}" : "/Models";

    private long? ParentId => long.TryParse(Parent, out var p) ? p : null;

    public async Task<IActionResult> OnGetAsync(long? parent)
    {
        if (Id is { } id)
        {
            if (await FolderService.FindAsync(db, UserId, id) is not { } folder)
            {
                return NotFound();
            }

            Name = folder.Name;
            Parent = folder.ParentId?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? string.Empty;
        }
        else if (parent is { } p)
        {
            Parent = p.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }

        await LoadChoicesAsync();
        return Page();
    }

    public async Task<IActionResult> OnPostAsync()
    {
        var saved = Id is { } id
            ? await FolderService.UpdateAsync(db, UserId, id, Name, ParentId)
            : await FolderService.CreateAsync(db, UserId, Name, ParentId);
        if (saved.NotAllowed)
        {
            return NotFound();
        }

        if (!saved.Ok)
        {
            ModelState.AddModelError(nameof(Name), saved.Error!);
            await LoadChoicesAsync();
            return Page();
        }

        Flash(Text.T(IsNew ? "Common.CreatedNamed" : "Common.Saved", saved.Value!.Name));
        return LocalRedirect($"/Models?folder={saved.Value.Id}");
    }

    public async Task<IActionResult> OnPostDeleteAsync()
    {
        var folder = Id is { } id ? await FolderService.FindAsync(db, UserId, id) : null;
        if (folder is null || !await FolderService.DeleteAsync(db, UserId, folder.Id))
        {
            return NotFound();
        }

        Flash(Text.T("Common.DeletedNamed", folder.Name));
        return LocalRedirect(folder.ParentId is { } up ? $"/Models?folder={up}" : "/Models");
    }

    private async Task LoadChoicesAsync()
    {
        var all = await FolderService.AllAsync(db, UserId);
        ParentChoices = [new Choice(string.Empty, Text.T("Folders.Top")), .. FolderService.Tree(all, without: Id).Select(f => new Choice(f.Id.ToString(System.Globalization.CultureInfo.InvariantCulture), f.Label))];
    }
}
