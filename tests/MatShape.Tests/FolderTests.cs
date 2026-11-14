using MatShape.Data;
using MatShape.Services.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace MatShape.Tests;

/// <summary>
/// The folders: private to a person, nested, never into themselves, deleted without losing anything; a shared model is filed by everybody on their own. And the
/// migration from "documents" to "models", which must keep every model.
/// </summary>
public sealed class FolderTests
{
    private static ModelQuery In(long? folder) => new(null, null, "name", false, folder);

    private static async Task<IReadOnlyList<string>> NamesAsync(TestDatabase t, long userId, ModelQuery query)
        => (await ModelService.ListAsync(t.Db, userId, query, 1, 50)).Rows.Select(r => r.Name).ToList();

    [DbFact]
    public async Task Models_are_listed_in_the_folder_they_were_filed_in_and_a_search_looks_everywhere()
    {
        await using var t = await TestDatabase.CreateAsync();
        var ada = await t.AddUserAsync("Ada");
        var parts = (await FolderService.CreateAsync(t.Db, ada.Id, " Parts ", null)).Value!;
        Assert.Equal("Parts", parts.Name);
        var brackets = (await FolderService.CreateAsync(t.Db, ada.Id, "Brackets", parts.Id)).Value!;

        var top = (await ModelService.CreateAsync(t.Db, ada.Id, "Plate", null, null)).Value!;
        var inside = (await ModelService.CreateAsync(t.Db, ada.Id, "Angle bracket", null, null, brackets.Id)).Value!;
        Assert.Equal(brackets.Id, inside.FolderId);

        Assert.Equal(["Plate"], await NamesAsync(t, ada.Id, In(null)));
        Assert.Empty(await NamesAsync(t, ada.Id, In(parts.Id)));
        Assert.Equal(["Angle bracket"], await NamesAsync(t, ada.Id, In(brackets.Id)));

        // a search and a scope look through every folder
        Assert.Equal(["Angle bracket"], await NamesAsync(t, ada.Id, new ModelQuery("bracket", null, "name", false, null)));
        Assert.Equal(2, (await NamesAsync(t, ada.Id, new ModelQuery(null, "mine", "name", false, null))).Count);

        // the folders of a folder, with what is in them
        var children = await FolderService.ChildrenAsync(t.Db, ada.Id, null);
        Assert.Equal("Parts", Assert.Single(children).Name);
        Assert.Equal((0, 1), (children[0].Models, children[0].Folders));
        Assert.Equal((1, 0), ((await FolderService.ChildrenAsync(t.Db, ada.Id, parts.Id))[0].Models, (await FolderService.ChildrenAsync(t.Db, ada.Id, parts.Id))[0].Folders));
        Assert.Equal("Brackets", Assert.Single(await FolderService.ChildrenAsync(t.Db, ada.Id, null, "brack")).Name);

        // filing is not a change of the design: the date of the last change stays
        var before = await t.Db.Models.AsNoTracking().Where(m => m.Id == top.Id).Select(m => m.UpdateDate).FirstAsync();
        Assert.True(await FolderService.FileAsync(t.Db, ada.Id, top.Id, parts.Id));
        var after = await t.Db.Models.AsNoTracking().Where(m => m.Id == top.Id).Select(m => new { m.UpdateDate, m.FolderId }).FirstAsync();
        Assert.Equal((before, (long?)parts.Id), (after.UpdateDate, after.FolderId));
        Assert.Equal(["Plate"], await NamesAsync(t, ada.Id, In(parts.Id)));

        // a copy lands next to the original
        var copy = (await ModelService.DuplicateAsync(t.Db, ada.Id, inside.Id, "copy")).Value!;
        Assert.Equal(brackets.Id, copy.FolderId);
    }

    [DbFact]
    public async Task Everybody_files_a_shared_model_in_folders_of_their_own()
    {
        await using var t = await TestDatabase.CreateAsync();
        var ada = await t.AddUserAsync("Ada");
        var bob = await t.AddUserAsync("Bob");
        var adas = (await FolderService.CreateAsync(t.Db, ada.Id, "Customers", null)).Value!;
        var bobs = (await FolderService.CreateAsync(t.Db, bob.Id, "From Ada", null)).Value!;
        var model = (await ModelService.CreateAsync(t.Db, ada.Id, "Housing", null, null, adas.Id)).Value!;
        await ModelService.AddMemberAsync(t.Db, ada.Id, model.Id, "bob@example.com", ModelRole.Viewer);

        // Bob sees it at his top, not in the folder of Ada
        Assert.Equal(["Housing"], await NamesAsync(t, bob.Id, In(null)));
        Assert.True(await FolderService.FileAsync(t.Db, bob.Id, model.Id, bobs.Id));
        Assert.Equal(["Housing"], await NamesAsync(t, bob.Id, In(bobs.Id)));
        Assert.Empty(await NamesAsync(t, bob.Id, In(null)));
        Assert.Equal(["Housing"], await NamesAsync(t, ada.Id, In(adas.Id)));
        Assert.Equal(bobs.Id, await FolderService.FolderOfAsync(t.Db, bob.Id, model.Id));

        // nobody uses the folders of somebody else: not to file in, not to look into, not to change
        Assert.False(await FolderService.FileAsync(t.Db, bob.Id, model.Id, adas.Id));
        Assert.False(await FolderService.FileAsync(t.Db, ada.Id, model.Id, bobs.Id));
        Assert.Null(await FolderService.FindAsync(t.Db, bob.Id, adas.Id));
        Assert.Empty(await FolderService.ChildrenAsync(t.Db, bob.Id, adas.Id));
        Assert.True((await FolderService.CreateAsync(t.Db, bob.Id, "Mine", adas.Id)).NotAllowed);
        Assert.True((await FolderService.UpdateAsync(t.Db, bob.Id, adas.Id, "Taken", null)).NotAllowed);
        Assert.True((await FolderService.MoveAsync(t.Db, bob.Id, bobs.Id, adas.Id)).NotAllowed);
        Assert.False(await FolderService.DeleteAsync(t.Db, bob.Id, adas.Id));

        // a model that is not shared with a person cannot be filed by them
        var other = (await ModelService.CreateAsync(t.Db, ada.Id, "Secret", null, null)).Value!;
        Assert.False(await FolderService.FileAsync(t.Db, bob.Id, other.Id, bobs.Id));

        // leaving the model ends the filing of Bob; Ada keeps hers
        Assert.True(await ModelService.RemoveMemberAsync(t.Db, bob.Id, model.Id, bob.Id));
        Assert.Equal(0, (await FolderService.ChildrenAsync(t.Db, bob.Id, null))[0].Models);
        Assert.Equal(1, (await FolderService.ChildrenAsync(t.Db, ada.Id, null))[0].Models);
    }

    [DbFact]
    public async Task A_folder_never_goes_into_itself_and_deleting_it_deletes_nothing_in_it()
    {
        await using var t = await TestDatabase.CreateAsync();
        var ada = await t.AddUserAsync("Ada");
        var bob = await t.AddUserAsync("Bob");
        var a = (await FolderService.CreateAsync(t.Db, ada.Id, "A", null)).Value!;
        var b = (await FolderService.CreateAsync(t.Db, ada.Id, "B", a.Id)).Value!;
        var c = (await FolderService.CreateAsync(t.Db, ada.Id, "C", b.Id)).Value!;

        // not into itself, not into a folder inside it
        Assert.False((await FolderService.MoveAsync(t.Db, ada.Id, a.Id, a.Id)).Ok);
        Assert.False((await FolderService.MoveAsync(t.Db, ada.Id, a.Id, c.Id)).Ok);
        Assert.False((await FolderService.UpdateAsync(t.Db, ada.Id, b.Id, "B", c.Id)).Ok);
        Assert.True((await FolderService.MoveAsync(t.Db, ada.Id, c.Id, null)).Ok);
        Assert.True((await FolderService.MoveAsync(t.Db, ada.Id, c.Id, b.Id)).Ok);
        Assert.Equal(["A", "B", "C"], FolderService.PathOf(await FolderService.AllAsync(t.Db, ada.Id), c.Id).Select(f => f.Name));

        // the tree for a choice leaves out the folder that moves and what is in it
        var all = await FolderService.AllAsync(t.Db, ada.Id);
        Assert.Equal(3, FolderService.Tree(all).Count);
        Assert.Equal([a.Id], FolderService.Tree(all, without: b.Id).Select(x => x.Id));

        // no deeper than allowed
        long? parent = c.Id;
        for (var depth = 4; depth <= FolderService.DepthMax; depth++)
        {
            parent = (await FolderService.CreateAsync(t.Db, ada.Id, "L" + depth, parent)).Value!.Id;
        }

        Assert.False((await FolderService.CreateAsync(t.Db, ada.Id, "Too deep", parent)).Ok);
        Assert.False((await FolderService.CreateAsync(t.Db, ada.Id, " ", null)).Ok);

        // deleting B: C and the model in B move up into A, the model stays
        var model = (await ModelService.CreateAsync(t.Db, ada.Id, "Gear", null, null, b.Id)).Value!;
        await ModelService.AddMemberAsync(t.Db, ada.Id, model.Id, "bob@example.com", ModelRole.Editor);
        var bobs = (await FolderService.CreateAsync(t.Db, bob.Id, "Work", null)).Value!;
        var bobsInner = (await FolderService.CreateAsync(t.Db, bob.Id, "Inner", bobs.Id)).Value!;
        Assert.True(await FolderService.FileAsync(t.Db, bob.Id, model.Id, bobsInner.Id));

        Assert.True(await FolderService.DeleteAsync(t.Db, ada.Id, b.Id));
        Assert.Equal(a.Id, await t.Db.Folders.AsNoTracking().Where(f => f.Id == c.Id).Select(f => f.ParentId).FirstAsync());
        Assert.Equal(["Gear"], await NamesAsync(t, ada.Id, In(a.Id)));

        // Bob's filing is his own: deleting his folder puts the model where the folder was
        Assert.True(await FolderService.DeleteAsync(t.Db, bob.Id, bobsInner.Id));
        Assert.Equal(["Gear"], await NamesAsync(t, bob.Id, In(bobs.Id)));
        Assert.True(await FolderService.DeleteAsync(t.Db, bob.Id, bobs.Id));
        Assert.Equal(["Gear"], await NamesAsync(t, bob.Id, In(null)));
    }

    [DbFact]
    public async Task Erasing_an_account_takes_its_nested_folders_with_it()
    {
        await using var t = await TestDatabase.CreateAsync();
        var ada = await t.AddUserAsync("Ada");
        var a = (await FolderService.CreateAsync(t.Db, ada.Id, "A", null)).Value!;
        var b = (await FolderService.CreateAsync(t.Db, ada.Id, "B", a.Id)).Value!;
        await FolderService.CreateAsync(t.Db, ada.Id, "C", b.Id);
        await ModelService.CreateAsync(t.Db, ada.Id, "In B", null, null, b.Id);

        await new MatShape.Services.Auth.AccountDataService(t.Db).EraseAsync(ada.Id);
        Assert.Equal(0, await t.Db.Folders.CountAsync());
        Assert.Equal(0, await t.Db.Models.IgnoreQueryFilters().CountAsync());
    }

    [DbFact]
    public async Task The_migration_to_models_keeps_every_document()
    {
        await using var t = await TestDatabase.CreateAsync(migrate: false);
        var migrator = t.Db.GetService<IMigrator>();
        await migrator.MigrateAsync("20261104204637_Ai");
        var ada = await t.AddUserAsync("Ada");
        var bob = await t.AddUserAsync("Bob");

        await t.Db.Database.ExecuteSqlAsync($"""
            INSERT INTO "Document" ("Id", "Name", "OwnerId", "Units", "ShareToken", "LinkMode", "CreateDate", "UpdateDate", "UpdateState")
            VALUES (7, 'Old bracket', {ada.Id}, 'mm', gen_random_uuid(), 1, now(), now(), 1)
            """);
        await t.Db.Database.ExecuteSqlAsync($"""
            INSERT INTO "DocumentMember" ("DocumentId", "UserId", "Role", "CreateDate", "UpdateDate") VALUES (7, {bob.Id}, 2, now(), now())
            """);
        await t.Db.Database.ExecuteSqlAsync($"""
            INSERT INTO "PartStudio" ("DocumentId", "Name", "Position", "Content", "Revision", "CreateDate", "UpdateDate", "UpdateState")
            VALUES (7, 'Part Studio 1', 0, {StudioContent.Empty}::jsonb, 3, now(), now(), 1)
            """);
        await t.Db.Database.ExecuteSqlAsync($"""
            INSERT INTO "DocumentVersion" ("DocumentId", "Name", "Content", "CreateDate", "UpdateDate") VALUES (7, 'V1', '[]'::jsonb, now(), now())
            """);

        await migrator.MigrateAsync();
        t.Db.ChangeTracker.Clear();

        var open = await StudioService.OpenAsync(t.Db, Actor.Of(bob.Id), 7);
        Assert.NotNull(open);
        Assert.Equal("Old bracket", open.Name);
        Assert.True(open.CanEdit);
        Assert.Equal(3, Assert.Single(open.Studios).Revision);
        Assert.Single(await t.Db.ModelVersions.Where(v => v.ModelId == 7).ToListAsync());
        Assert.Equal(["Old bracket"], await NamesAsync(t, ada.Id, In(null)));

        // and new models get new numbers (the sequence of the renamed table goes on)
        var next = (await ModelService.CreateAsync(t.Db, ada.Id, "New", null, null)).Value!;
        Assert.NotEqual(7, next.Id);
        await FolderService.CreateAsync(t.Db, ada.Id, "Works", null);
    }
}
