using MatShape.Data;
using MatShape.Localization;
using MatShape.Services;
using MatShape.Services.Documents;
using Microsoft.AspNetCore.Mvc;

namespace MatShape.Pages.Documents;

/// <summary>
/// Create a version of a document (the state of every Part Studio now), rename it, restore it or delete it. Editors create, rename and restore; only the owner deletes.
/// The business layer checks every right again.
/// </summary>
public sealed class VersionModel(AppDbContext db) : AppPageModel
{
    [BindProperty(SupportsGet = true)] public long DocumentId { get; set; }

    [BindProperty(SupportsGet = true)] public long? Id { get; set; }

    [BindProperty] public string Name { get; set; } = string.Empty;

    [BindProperty] public string Description { get; set; } = string.Empty;

    public string DocumentName { get; private set; } = string.Empty;

    public bool CanDelete { get; private set; }

    public bool IsNew => Id is null;

    public async Task<IActionResult> OnGetAsync()
    {
        if (!await LoadAsync(fillForm: true))
        {
            return NotFound();
        }

        if (IsNew)
        {
            Name = Text.T("Versions.DefaultName", Dates.Stamp(DateTime.UtcNow, Me.TimeZone));
        }

        return Page();
    }

    public async Task<IActionResult> OnPostAsync()
    {
        if (!await LoadAsync(fillForm: false))
        {
            return NotFound();
        }

        var saved = Id is { } id
            ? await VersionService.UpdateAsync(db, UserId, id, Name, Description)
            : await VersionService.CreateAsync(db, UserId, DocumentId, Name, Description);
        if (saved.NotAllowed)
        {
            return NotFound();
        }

        if (!saved.Ok)
        {
            ModelState.AddModelError(nameof(Name), saved.Error!);
            return Page();
        }

        Flash(Text.T(IsNew ? "Common.CreatedNamed" : "Common.Saved", saved.Value!.Name));
        return LocalRedirect($"/Documents/Versions?id={DocumentId}");
    }

    public async Task<IActionResult> OnPostRestoreAsync()
    {
        if (Id is not { } id)
        {
            return NotFound();
        }

        var restored = await VersionService.RestoreAsync(db, UserId, id, Text.T("Versions.BeforeRestore", Dates.Stamp(DateTime.UtcNow, Me.TimeZone)));
        if (restored.NotAllowed)
        {
            return NotFound();
        }

        if (!restored.Ok)
        {
            FlashError(restored.Error!);
            return LocalRedirect($"/Documents/Versions?id={DocumentId}");
        }

        Flash(Text.T("Versions.Restored"));
        return LocalRedirect($"/Documents/Studio/{restored.Value}");
    }

    public async Task<IActionResult> OnPostDeleteAsync()
    {
        if (Id is not { } id || !await VersionService.DeleteAsync(db, UserId, id))
        {
            return NotFound();
        }

        Flash(Text.T("Common.DeletedNamed", Name));
        return LocalRedirect($"/Documents/Versions?id={DocumentId}");
    }

    /// <summary>The document (editor right needed to be here at all) and, for an existing version, the version; it must belong to the document of the address.</summary>
    private async Task<bool> LoadAsync(bool fillForm)
    {
        if (await DocumentAccess.FindAsync(db, Actor.Of(UserId), DocumentId, DocumentRole.Editor) is not { } access)
        {
            return false;
        }

        DocumentName = access.Document.Name;
        CanDelete = access.IsOwner;
        if (Id is not { } id)
        {
            return true;
        }

        if (await VersionService.GetAsync(db, UserId, id) is not { } found || found.Version.DocumentId != DocumentId)
        {
            return false;
        }

        if (fillForm)
        {
            Name = found.Version.Name;
            Description = found.Version.Description ?? string.Empty;
        }

        return true;
    }
}
