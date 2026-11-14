using MatShape.Controls;
using MatShape.Data;
using MatShape.Localization;
using MatShape.Services;
using MatShape.Services.Models;
using MatShape.Services.Mail;
using Microsoft.AspNetCore.Mvc;

namespace MatShape.Pages.Models;

/// <summary>Who a model is shared with: add a person by their address, give them another role, take them off. Only the owner (the business layer checks it again).</summary>
public sealed class MembersModel(AppDbContext db, MailService mail, InstanceService instance) : AppPageModel
{
    [BindProperty(SupportsGet = true)] public long Id { get; set; }

    [BindProperty] public string Email { get; set; } = string.Empty;

    [BindProperty] public ModelRole NewRole { get; set; } = ModelRole.Editor;

    public string ModelName { get; private set; } = string.Empty;

    public string OwnerName { get; private set; } = string.Empty;

    public string OwnerEmail { get; private set; } = string.Empty;

    public IReadOnlyList<MemberRow> Members { get; private set; } = [];

    public List<Choice> Roles { get; } =
    [
        new(nameof(ModelRole.Editor), Text.T("Models.Role.Editor")),
        new(nameof(ModelRole.Viewer), Text.T("Models.Role.Viewer")),
    ];

    public async Task<IActionResult> OnGetAsync() => await LoadAsync() ? Page() : NotFound();

    public async Task<IActionResult> OnPostAddAsync()
    {
        var added = await ModelService.AddMemberAsync(db, UserId, Id, Email, NewRole);
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
        return LocalRedirect($"/Models/Members?id={Id}");
    }

    public async Task<IActionResult> OnPostRoleAsync(long memberId, ModelRole role)
    {
        if (!await ModelService.SetMemberRoleAsync(db, UserId, Id, memberId, role))
        {
            return NotFound();
        }

        Flash(Text.T("Common.Saved"));
        return LocalRedirect($"/Models/Members?id={Id}");
    }

    public async Task<IActionResult> OnPostRemoveAsync(long memberId)
    {
        if (!await ModelService.RemoveMemberAsync(db, UserId, Id, memberId))
        {
            return NotFound();
        }

        Flash(Text.T("Members.Removed"));
        return LocalRedirect($"/Models/Members?id={Id}");
    }

    private async Task<bool> LoadAsync()
    {
        if (await ModelAccess.FindAsync(db, Actor.Of(UserId), Id, ModelRole.Owner) is not { } access
            || await ModelService.MembersAsync(db, UserId, Id) is not { } members)
        {
            return false;
        }

        ModelName = access.Model.Name;
        OwnerName = Me.DisplayName;
        OwnerEmail = Me.Snapshot!.Email;
        Members = members;
        return true;
    }

    /// <summary>A mail to the person the model was shared with, when the installation can send mail and the person wants it. Words in the language of the person.</summary>
    private async Task TellAsync(MemberRow person)
    {
        if (!mail.IsConfigured || !await ModelService.WantsShareMailAsync(db, person.UserId))
        {
            return;
        }

        var (_, publicUrl) = await instance.SettingsAsync();
        var origin = publicUrl ?? $"{Request.Scheme}://{Request.Host}";
        var language = await ModelService.LanguageOfAsync(db, person.UserId);
        var model = ModelName;
        var sender = Me.DisplayName;
        var role = person.Role;
        var text = Languages.In(language, () => Text.T(role == ModelRole.Editor ? "Mail.Share.Editor" : "Mail.Share.Viewer", sender, model, $"{origin}/Models/Studio/{Id}"));
        var subject = Languages.In(language, () => Text.T("Mail.Share.Subject", sender, model));
        mail.Enqueue(new OutgoingMail(person.Email, person.Name, subject, text));
    }
}
