using MatShape.Controls;
using MatShape.Data;
using MatShape.Localization;
using MatShape.Services;
using MatShape.Services.Documents;
using Microsoft.AspNetCore.Mvc;

namespace MatShape.Pages.Documents;

/// <summary>Create a document, change its name, description and units, delete it. Only the owner may change an existing document (the business layer checks it again).</summary>
public sealed class EditModel(AppDbContext db) : AppPageModel
{
    [BindProperty(SupportsGet = true)] public long? Id { get; set; }

    [BindProperty] public string Name { get; set; } = string.Empty;

    [BindProperty] public string Description { get; set; } = string.Empty;

    [BindProperty] public string Units { get; set; } = DocumentUnits.Default;

    public bool IsNew => Id is null;

    public List<Choice> UnitChoices { get; } = DocumentUnits.All.Select(u => new Choice(u, Text.T("Units." + u))).ToList();

    public async Task<IActionResult> OnGetAsync()
    {
        if (Id is not { } id)
        {
            Units = await DocumentService.DefaultUnitsAsync(db, UserId);
            return Page();
        }

        if (await DocumentAccess.FindAsync(db, Actor.Of(UserId), id, DocumentRole.Owner) is not { } access)
        {
            return NotFound();
        }

        Name = access.Document.Name;
        Description = access.Document.Description ?? string.Empty;
        Units = access.Document.Units;
        return Page();
    }

    public async Task<IActionResult> OnPostAsync()
    {
        if (Id is { } id)
        {
            var saved = await DocumentService.UpdateAsync(db, UserId, id, Name, Description, Units);
            if (saved.NotAllowed)
            {
                return NotFound();
            }

            if (!saved.Ok)
            {
                ModelState.AddModelError(nameof(Name), saved.Error!);
                return Page();
            }

            Flash(Text.T("Common.Saved"));
            return LocalRedirect("/Documents");
        }

        var created = await DocumentService.CreateAsync(db, UserId, Name, Description, Units);
        if (!created.Ok)
        {
            ModelState.AddModelError(nameof(Name), created.Error!);
            return Page();
        }

        Flash(Text.T("Common.CreatedNamed", created.Value!.Name));
        return LocalRedirect($"/Documents/Studio/{created.Value.Id}");
    }

    public async Task<IActionResult> OnPostDeleteAsync()
    {
        if (Id is not { } id || !await DocumentService.DeleteAsync(db, UserId, id))
        {
            return NotFound();
        }

        Flash(Text.T("Common.DeletedNamed", Name));
        return LocalRedirect("/Documents");
    }
}
