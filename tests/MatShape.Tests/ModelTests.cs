using MatShape.Data;
using MatShape.Services.Models;
using Microsoft.EntityFrameworkCore;

namespace MatShape.Tests;

/// <summary>
/// The business layer of the models: who sees and changes what (owner, editor, viewer, link, the administrator of the installation), saving with the revision,
/// the tabs of the Part Studios and the versions.
/// </summary>
public sealed class ModelTests
{
    private const string Plate = """{"features":[{"id":"v","type":"variable","name":"w","params":{"name":"w","value":"10"}}],"parts":{},"rollback":null}""";

    [DbFact]
    public async Task A_new_model_has_one_Part_Studio_and_only_its_owner_sees_it()
    {
        await using var t = await TestDatabase.CreateAsync();
        var ada = await t.AddUserAsync("Ada");
        var bob = await t.AddUserAsync("Bob");
        var admin = await t.AddUserAsync("Root", UserRole.Admin);

        var created = await ModelService.CreateAsync(t.Db, ada.Id, " Bracket ", null, "in");
        Assert.True(created.Ok);
        Assert.Equal("Bracket", created.Value!.Name);
        Assert.Equal("in", created.Value.Units);

        var open = await StudioService.OpenAsync(t.Db, Actor.Of(ada.Id), created.Value.Id);
        Assert.NotNull(open);
        Assert.Single(open.Studios);
        Assert.True(open.CanEdit);

        // nobody else, not even the administrator of the installation
        Assert.Null(await StudioService.OpenAsync(t.Db, Actor.Of(bob.Id), created.Value.Id));
        Assert.Null(await StudioService.OpenAsync(t.Db, Actor.Of(admin.Id), created.Value.Id));
        Assert.Equal(0, (await ModelService.ListAsync(t.Db, bob.Id, new ModelQuery(null, null, "changed", true), 1, 10)).Total);
    }

    [DbFact]
    public async Task Saving_needs_the_newest_revision_and_the_editor_right()
    {
        await using var t = await TestDatabase.CreateAsync();
        var ada = await t.AddUserAsync("Ada");
        var bob = await t.AddUserAsync("Bob");
        var model = (await ModelService.CreateAsync(t.Db, ada.Id, "Plate", null, null)).Value!;
        var studio = (await StudioService.OpenAsync(t.Db, Actor.Of(ada.Id), model.Id))!.Studios[0];

        var first = await StudioService.SaveAsync(t.Db, ada.Id, studio.Id, studio.Revision, Plate);
        Assert.Equal(SaveStatus.Saved, first.Status);
        Assert.Equal(studio.Revision + 1, first.Revision);

        // a browser that started from the old revision gets the newer content back, nothing is overwritten
        var stale = await StudioService.SaveAsync(t.Db, ada.Id, studio.Id, studio.Revision, StudioContent.Empty);
        Assert.Equal(SaveStatus.Conflict, stale.Status);
        Assert.Contains("\"w\"", stale.Content);

        Assert.Equal(SaveStatus.Invalid, (await StudioService.SaveAsync(t.Db, ada.Id, studio.Id, first.Revision, "{\"features\":{}}")).Status);
        Assert.Equal(SaveStatus.Denied, (await StudioService.SaveAsync(t.Db, bob.Id, studio.Id, first.Revision, Plate)).Status);

        // a viewer looks but does not save
        await ModelService.AddMemberAsync(t.Db, ada.Id, model.Id, "bob@example.com", ModelRole.Viewer);
        Assert.NotNull(await StudioService.OpenAsync(t.Db, Actor.Of(bob.Id), model.Id));
        Assert.Equal(SaveStatus.Denied, (await StudioService.SaveAsync(t.Db, bob.Id, studio.Id, first.Revision, Plate)).Status);

        // an editor saves
        Assert.True(await ModelService.SetMemberRoleAsync(t.Db, ada.Id, model.Id, bob.Id, ModelRole.Editor));
        Assert.Equal(SaveStatus.Saved, (await StudioService.SaveAsync(t.Db, bob.Id, studio.Id, first.Revision, Plate)).Status);
        Assert.Equal("Bob", (await StudioService.RevisionAsync(t.Db, Actor.Of(ada.Id), studio.Id))!.Value.By);
    }

    [DbFact]
    public async Task Only_the_owner_changes_members_link_and_settings()
    {
        await using var t = await TestDatabase.CreateAsync();
        var ada = await t.AddUserAsync("Ada");
        var bob = await t.AddUserAsync("Bob");
        var model = (await ModelService.CreateAsync(t.Db, ada.Id, "Plate", null, null)).Value!;
        await ModelService.AddMemberAsync(t.Db, ada.Id, model.Id, "bob@example.com", ModelRole.Editor);

        Assert.True((await ModelService.UpdateAsync(t.Db, bob.Id, model.Id, "Mine now", null, null)).NotAllowed);
        Assert.True((await ModelService.AddMemberAsync(t.Db, bob.Id, model.Id, "ada@example.com", ModelRole.Editor)).NotAllowed);
        Assert.Null(await ModelService.SetLinkAsync(t.Db, bob.Id, model.Id, LinkMode.View, false));
        Assert.False(await ModelService.DeleteAsync(t.Db, bob.Id, model.Id));
        Assert.Equal(Members("Members.IsOwner"), (await ModelService.AddMemberAsync(t.Db, ada.Id, model.Id, "ada@example.com", ModelRole.Editor)).Error);

        // a member may leave
        Assert.True(await ModelService.RemoveMemberAsync(t.Db, bob.Id, model.Id, bob.Id));
        Assert.Null(await StudioService.OpenAsync(t.Db, Actor.Of(bob.Id), model.Id));
    }

    [DbFact]
    public async Task A_link_gives_a_look_and_a_new_secret_ends_it()
    {
        await using var t = await TestDatabase.CreateAsync();
        var ada = await t.AddUserAsync("Ada");
        var model = (await ModelService.CreateAsync(t.Db, ada.Id, "Plate", null, null)).Value!;
        var token = model.ShareToken;

        Assert.Null(await ModelAccess.FindByLinkAsync(t.Db, token));
        await ModelService.SetLinkAsync(t.Db, ada.Id, model.Id, LinkMode.View, false);
        var viaLink = await StudioService.OpenAsync(t.Db, Actor.Guest(token), model.Id);
        Assert.NotNull(viaLink);
        Assert.False(viaLink.CanEdit);

        var renewed = await ModelService.SetLinkAsync(t.Db, ada.Id, model.Id, LinkMode.View, true);
        Assert.NotEqual(token, renewed!.ShareToken);
        Assert.Null(await StudioService.OpenAsync(t.Db, Actor.Guest(token), model.Id));
    }

    [DbFact]
    public async Task Part_Studios_can_be_added_moved_and_deleted_but_one_stays()
    {
        await using var t = await TestDatabase.CreateAsync();
        var ada = await t.AddUserAsync("Ada");
        var model = (await ModelService.CreateAsync(t.Db, ada.Id, "Gearbox", null, null)).Value!;
        var first = (await StudioService.OpenAsync(t.Db, Actor.Of(ada.Id), model.Id))!.Studios[0];

        var second = await StudioService.AddAsync(t.Db, ada.Id, model.Id, "Housing");
        Assert.True(second.Ok);
        Assert.True(await StudioService.MoveAsync(t.Db, ada.Id, second.Value!.Id, -1));
        var order = (await StudioService.OpenAsync(t.Db, Actor.Of(ada.Id), model.Id))!.Studios.Select(s => s.Name).ToList();
        Assert.Equal("Housing", order[0]);

        Assert.True((await StudioService.DeleteAsync(t.Db, ada.Id, first.Id)).Ok);
        Assert.False((await StudioService.DeleteAsync(t.Db, ada.Id, second.Value.Id)).Ok);
    }

    [DbFact]
    public async Task A_version_is_restored_and_the_state_before_is_kept()
    {
        await using var t = await TestDatabase.CreateAsync();
        var ada = await t.AddUserAsync("Ada");
        var model = (await ModelService.CreateAsync(t.Db, ada.Id, "Plate", null, null)).Value!;
        var studio = (await StudioService.OpenAsync(t.Db, Actor.Of(ada.Id), model.Id))!.Studios[0];
        await StudioService.SaveAsync(t.Db, ada.Id, studio.Id, studio.Revision, Plate);

        var version = await VersionService.CreateAsync(t.Db, ada.Id, model.Id, "Release 1", null);
        Assert.True(version.Ok);

        var now = (await StudioService.OpenAsync(t.Db, Actor.Of(ada.Id), model.Id))!.Studios[0];
        await StudioService.SaveAsync(t.Db, ada.Id, now.Id, now.Revision, StudioContent.Empty);

        var restored = await VersionService.RestoreAsync(t.Db, ada.Id, version.Value!.Id, "Before");
        Assert.True(restored.Ok);
        t.Db.ChangeTracker.Clear();
        var back = (await StudioService.OpenAsync(t.Db, Actor.Of(ada.Id), model.Id))!.Studios.Single();
        Assert.Contains("\"w\"", back.Content);
        Assert.Equal(2, await t.Db.ModelVersions.CountAsync(v => v.ModelId == model.Id));

        // the version itself opens read-only
        var view = await StudioService.OpenAsync(t.Db, Actor.Of(ada.Id), model.Id, version.Value.Id);
        Assert.NotNull(view);
        Assert.False(view.CanEdit);
    }

    [DbFact]
    public async Task A_copy_takes_the_Part_Studios_but_not_the_people()
    {
        await using var t = await TestDatabase.CreateAsync();
        var ada = await t.AddUserAsync("Ada");
        var bob = await t.AddUserAsync("Bob");
        var model = (await ModelService.CreateAsync(t.Db, ada.Id, "Plate", null, null)).Value!;
        var studio = (await StudioService.OpenAsync(t.Db, Actor.Of(ada.Id), model.Id))!.Studios[0];
        await StudioService.SaveAsync(t.Db, ada.Id, studio.Id, studio.Revision, Plate);
        await ModelService.AddMemberAsync(t.Db, ada.Id, model.Id, "bob@example.com", ModelRole.Viewer);

        var copy = await ModelService.DuplicateAsync(t.Db, bob.Id, model.Id, "copy");
        Assert.True(copy.Ok);
        var opened = await StudioService.OpenAsync(t.Db, Actor.Of(bob.Id), copy.Value!.Id);
        Assert.Equal(ModelRole.Owner, opened!.Role);
        Assert.Contains("\"w\"", opened.Studios[0].Content);
        Assert.Null(await StudioService.OpenAsync(t.Db, Actor.Of(ada.Id), copy.Value.Id));
    }

    private static string Members(string key) => MatShape.Localization.Text.T(key);
}
