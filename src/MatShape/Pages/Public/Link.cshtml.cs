using MatShape.Data;
using MatShape.Services;
using MatShape.Services.Models;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace MatShape.Pages.Public;

/// <summary>
/// A model opened through its link (<c>/s/&lt;secret&gt;</c>), by anybody: the model can be turned, measured and exported, never changed. A link that is off, or wrong,
/// answers 404 exactly like a model that is not there.
/// </summary>
public sealed class LinkModel(AppDbContext db, CurrentUser me) : PageModel
{
    public StudioViewModel Studio { get; private set; } = null!;

    public async Task<IActionResult> OnGetAsync(Guid token)
    {
        if (await ModelAccess.FindByLinkAsync(db, token) is not { } viaLink)
        {
            return NotFound();
        }

        Studio = new StudioViewModel(viaLink.Model.Id, viaLink.Model.Name, ModelRole.Viewer, null, token.ToString(), !me.IsAuthenticated, me.DisplayName);
        Response.Headers.CacheControl = "no-store";
        return Page();
    }
}
