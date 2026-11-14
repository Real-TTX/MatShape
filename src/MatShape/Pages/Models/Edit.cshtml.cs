using MatShape.Controls;
using MatShape.Data;
using MatShape.Localization;
using MatShape.Services;
using MatShape.Services.Models;
using Microsoft.AspNetCore.Mvc;

namespace MatShape.Pages.Models;

/// <summary>Create a model, change its name, description and units, delete it. Only the owner may change an existing model (the business layer checks it again).</summary>
public sealed class EditModel(AppDbContext db) : AppPageModel
{
    [BindProperty(SupportsGet = true)] public long? Id { get; set; }

    /// <summary>A new model goes into this folder of the person (the list it was made from).</summary>
    [BindProperty(SupportsGet = true)] public long? Folder { get; set; }

    [BindProperty] public string Name { get; set; } = string.Empty;

    [BindProperty] public string Description { get; set; } = string.Empty;

    [BindProperty] public string Units { get; set; } = ModelUnits.Default;

    public bool IsNew => Id is null;

    public string BackUrl => IsNew && Folder is { } f ? $"/Models?folder={f}" : "/Models";

    public List<Choice> UnitChoices { get; } = ModelUnits.All.Select(u => new Choice(u, Text.T("Units." + u))).ToList();

    public async Task<IActionResult> OnGetAsync()
    {
        if (Id is not { } id)
        {
            Units = await ModelService.DefaultUnitsAsync(db, UserId);
            return Page();
        }

        if (await ModelAccess.FindAsync(db, Actor.Of(UserId), id, ModelRole.Owner) is not { } access)
        {
            return NotFound();
        }

        Name = access.Model.Name;
        Description = access.Model.Description ?? string.Empty;
        Units = access.Model.Units;
        return Page();
    }

    public async Task<IActionResult> OnPostAsync()
    {
        if (Id is { } id)
        {
            var saved = await ModelService.UpdateAsync(db, UserId, id, Name, Description, Units);
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
            return LocalRedirect("/Models");
        }

        var created = await ModelService.CreateAsync(db, UserId, Name, Description, Units, Folder);
        if (!created.Ok)
        {
            ModelState.AddModelError(nameof(Name), created.Error!);
            return Page();
        }

        Flash(Text.T("Common.CreatedNamed", created.Value!.Name));
        return LocalRedirect($"/Models/Studio/{created.Value.Id}");
    }

    public async Task<IActionResult> OnPostDeleteAsync()
    {
        if (Id is not { } id || !await ModelService.DeleteAsync(db, UserId, id))
        {
            return NotFound();
        }

        Flash(Text.T("Common.DeletedNamed", Name));
        return LocalRedirect("/Models");
    }
}
