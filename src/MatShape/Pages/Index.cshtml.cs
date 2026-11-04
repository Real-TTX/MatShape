using MatShape.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.RazorPages;

namespace MatShape.Pages;

/// <summary>The start page: for a visitor what MatShape is, for a signed-in person straight to the documents.</summary>
public sealed class IndexModel(AccountService accounts, CurrentUser me) : PageModel
{
    public bool RegistrationOpen { get; private set; }

    public async Task<IActionResult> OnGetAsync()
    {
        if (me.IsAuthenticated)
        {
            return LocalRedirect("/Documents");
        }

        RegistrationOpen = !await accounts.AnyUserAsync() || (await accounts.SettingsAsync()).RegistrationOpen;
        return Page();
    }
}
