using MatShape.Data;
using MatShape.Services;
using MatShape.Services.Documents;
using Microsoft.AspNetCore.Mvc;

namespace MatShape.Pages.Documents;

/// <summary>
/// The editor of a document (its Part Studios), opened by a person who may see it. The model itself comes from the scripts (<c>/live/documents/{id}</c>): the page only says
/// who looks and what they may do. With <c>?version=</c> it shows that version, read-only.
/// </summary>
public sealed class StudioModel(AppDbContext db) : AppPageModel
{
    public StudioViewModel Studio { get; private set; } = null!;

    public async Task<IActionResult> OnGetAsync(long id, long? version)
    {
        if (await DocumentAccess.FindAsync(db, Actor.Of(UserId), id) is not { } access)
        {
            return NotFound();
        }

        var ai = access.CanEdit && version is null && await MatShape.Services.Ai.AiService.IsAvailableAsync(db, HttpContext.RequestServices);
        Studio = new StudioViewModel(access.Document.Id, access.Document.Name, access.Role, version, null, false, Me.DisplayName, ai);
        Response.Headers.CacheControl = "no-store";
        return Page();
    }
}
