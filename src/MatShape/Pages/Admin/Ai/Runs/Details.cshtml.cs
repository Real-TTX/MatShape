using MatShape.Data;
using MatShape.Services.Ai;
using Microsoft.AspNetCore.Mvc;

namespace MatShape.Pages.Admin.Ai.Runs;

/// <summary>One call of the AI with every step: exactly what was sent, what came back, the warnings.</summary>
public sealed class DetailsModel(AppDbContext db) : AppPageModel
{
    public AiRun Run { get; private set; } = null!;

    public string? UserName { get; private set; }

    public string Zone => Me.TimeZone;

    public async Task<IActionResult> OnGetAsync(long id)
    {
        if (await AiAdmin.RunAsync(new AiContext(db, HttpContext.RequestServices, UserId), id) is not { } found)
        {
            return NotFound();
        }

        (Run, UserName) = found;
        return Page();
    }
}
