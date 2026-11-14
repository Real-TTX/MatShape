using MatShape.Data;
using MatShape.Services;
using MatShape.Services.Models;
using Microsoft.AspNetCore.Mvc;

namespace MatShape.Pages.Models;

/// <summary>
/// The editor of a model (its Part Studios), opened by a person who may see it. The model itself comes from the scripts (<c>/live/models/{id}</c>): the page only says
/// who looks and what they may do. With <c>?version=</c> it shows that version, read-only.
/// </summary>
public sealed class StudioModel(AppDbContext db) : AppPageModel
{
    public StudioViewModel Studio { get; private set; } = null!;

    public async Task<IActionResult> OnGetAsync(long id, long? version)
    {
        if (await ModelAccess.FindAsync(db, Actor.Of(UserId), id) is not { } access)
        {
            return NotFound();
        }

        var ai = access.CanEdit && version is null && await MatShape.Services.Ai.AiService.IsAvailableAsync(db, HttpContext.RequestServices);
        var mesh = access.CanEdit && version is null && await MatShape.Services.Ai.MeshService.IsAvailableAsync(db, HttpContext.RequestServices);
        var folder = await FolderService.FolderOfAsync(db, UserId, id);
        Studio = new StudioViewModel(access.Model.Id, access.Model.Name, access.Role, version, null, false, Me.DisplayName, ai, folder, mesh);
        Response.Headers.CacheControl = "no-store";
        return Page();
    }
}
