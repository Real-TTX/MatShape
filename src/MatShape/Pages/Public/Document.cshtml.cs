using MatShape.Data;
using MatShape.Services;
using MatShape.Services.Documents;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace MatShape.Pages.Public;

/// <summary>
/// A document opened through its link (<c>/s/&lt;secret&gt;</c>), by anybody: the model can be turned, measured and exported, never changed. A link that is off, or wrong,
/// answers 404 exactly like a document that is not there.
/// </summary>
public sealed class DocumentModel(AppDbContext db, CurrentUser me) : PageModel
{
    public StudioViewModel Studio { get; private set; } = null!;

    public async Task<IActionResult> OnGetAsync(Guid token)
    {
        if (await DocumentAccess.FindByLinkAsync(db, token) is not { } viaLink)
        {
            return NotFound();
        }

        Studio = new StudioViewModel(viaLink.Document.Id, viaLink.Document.Name, DocumentRole.Viewer, null, token.ToString(), !me.IsAuthenticated, me.DisplayName);
        Response.Headers.CacheControl = "no-store";
        return Page();
    }
}
