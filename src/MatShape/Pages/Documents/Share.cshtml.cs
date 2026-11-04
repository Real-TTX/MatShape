using MatShape.Controls;
using MatShape.Data;
using MatShape.Localization;
using MatShape.Services;
using MatShape.Services.Documents;
using Microsoft.AspNetCore.Mvc;

namespace MatShape.Pages.Documents;

/// <summary>The link of a document: whether anybody who has it may look at the model (read-only), and a new secret when the old address got out. Only the owner.</summary>
public sealed class ShareModel(AppDbContext db, InstanceService instance) : AppPageModel
{
    [BindProperty(SupportsGet = true)] public long Id { get; set; }

    [BindProperty] public string Mode { get; set; } = nameof(LinkMode.Off);

    public string DocumentName { get; private set; } = string.Empty;

    public string LinkUrl { get; private set; } = string.Empty;

    public List<Choice> Modes { get; } =
    [
        new(nameof(LinkMode.Off), Text.T("Share.Mode.Off")),
        new(nameof(LinkMode.View), Text.T("Share.Mode.View")),
    ];

    public async Task<IActionResult> OnGetAsync() => await LoadAsync() ? Page() : NotFound();

    public Task<IActionResult> OnPostAsync() => ChangeAsync(renew: false);

    public Task<IActionResult> OnPostRenewAsync() => ChangeAsync(renew: true);

    private async Task<IActionResult> ChangeAsync(bool renew)
    {
        var mode = Enum.TryParse<LinkMode>(Mode, out var parsed) && Enum.IsDefined(parsed) ? parsed : LinkMode.Off;
        if (await DocumentService.SetLinkAsync(db, UserId, Id, mode, renew) is null)
        {
            return NotFound();
        }

        Flash(Text.T(renew ? "Share.Renewed" : "Common.Saved"));
        return LocalRedirect($"/Documents/Share?id={Id}");
    }

    private async Task<bool> LoadAsync()
    {
        if (await DocumentAccess.FindAsync(db, Actor.Of(UserId), Id, DocumentRole.Owner) is not { } access)
        {
            return false;
        }

        DocumentName = access.Document.Name;
        Mode = access.Document.LinkMode.ToString();
        var (_, publicUrl) = await instance.SettingsAsync();
        LinkUrl = $"{publicUrl ?? $"{Request.Scheme}://{Request.Host}"}/s/{access.Document.ShareToken}";
        return true;
    }
}
