using MatShape.Controls;
using MatShape.Data;
using MatShape.Localization;
using MatShape.Services;
using MatShape.Services.Documents;
using MatShape.Services.Mail;
using Microsoft.AspNetCore.Mvc;

namespace MatShape.Pages.Documents;

/// <summary>Who a document is shared with: add a person by their address, give them another role, take them off. Only the owner (the business layer checks it again).</summary>
public sealed class MembersModel(AppDbContext db, MailService mail, InstanceService instance) : AppPageModel
{
    [BindProperty(SupportsGet = true)] public long Id { get; set; }

    [BindProperty] public string Email { get; set; } = string.Empty;

    [BindProperty] public DocumentRole NewRole { get; set; } = DocumentRole.Editor;

    public string DocumentName { get; private set; } = string.Empty;

    public string OwnerName { get; private set; } = string.Empty;

    public string OwnerEmail { get; private set; } = string.Empty;

    public IReadOnlyList<MemberRow> Members { get; private set; } = [];

    public List<Choice> Roles { get; } =
    [
        new(nameof(DocumentRole.Editor), Text.T("Documents.Role.Editor")),
        new(nameof(DocumentRole.Viewer), Text.T("Documents.Role.Viewer")),
    ];

    public async Task<IActionResult> OnGetAsync() => await LoadAsync() ? Page() : NotFound();

    public async Task<IActionResult> OnPostAddAsync()
    {
        var added = await DocumentService.AddMemberAsync(db, UserId, Id, Email, NewRole);
        if (added.NotAllowed)
        {
            return NotFound();
        }

        if (!added.Ok)
        {
            ModelState.AddModelError(nameof(Email), added.Error!);
            await LoadAsync();
            return Page();
        }

        await TellAsync(added.Value!);
        Flash(Text.T("Members.Added", added.Value!.Name));
        return LocalRedirect($"/Documents/Members?id={Id}");
    }

    public async Task<IActionResult> OnPostRoleAsync(long memberId, DocumentRole role)
    {
        if (!await DocumentService.SetMemberRoleAsync(db, UserId, Id, memberId, role))
        {
            return NotFound();
        }

        Flash(Text.T("Common.Saved"));
        return LocalRedirect($"/Documents/Members?id={Id}");
    }

    public async Task<IActionResult> OnPostRemoveAsync(long memberId)
    {
        if (!await DocumentService.RemoveMemberAsync(db, UserId, Id, memberId))
        {
            return NotFound();
        }

        Flash(Text.T("Members.Removed"));
        return LocalRedirect($"/Documents/Members?id={Id}");
    }

    private async Task<bool> LoadAsync()
    {
        if (await DocumentAccess.FindAsync(db, Actor.Of(UserId), Id, DocumentRole.Owner) is not { } access
            || await DocumentService.MembersAsync(db, UserId, Id) is not { } members)
        {
            return false;
        }

        DocumentName = access.Document.Name;
        OwnerName = Me.DisplayName;
        OwnerEmail = Me.Snapshot!.Email;
        Members = members;
        return true;
    }

    /// <summary>A mail to the person the document was shared with, when the installation can send mail and the person wants it. Words in the language of the person.</summary>
    private async Task TellAsync(MemberRow person)
    {
        if (!mail.IsConfigured || !await DocumentService.WantsShareMailAsync(db, person.UserId))
        {
            return;
        }

        var (_, publicUrl) = await instance.SettingsAsync();
        var origin = publicUrl ?? $"{Request.Scheme}://{Request.Host}";
        var language = await DocumentService.LanguageOfAsync(db, person.UserId);
        var document = DocumentName;
        var sender = Me.DisplayName;
        var role = person.Role;
        var text = Languages.In(language, () => Text.T(role == DocumentRole.Editor ? "Mail.Share.Editor" : "Mail.Share.Viewer", sender, document, $"{origin}/Documents/Studio/{Id}"));
        var subject = Languages.In(language, () => Text.T("Mail.Share.Subject", sender, document));
        mail.Enqueue(new OutgoingMail(person.Email, person.Name, subject, text));
    }
}
