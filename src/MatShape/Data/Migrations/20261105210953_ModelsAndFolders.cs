using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace MatShape.Data.Migrations
{
    /// <summary>
    /// Documents are called models now: the tables, columns, keys and indexes are RENAMED (written by hand – the scaffolded migration dropped and created the
    /// tables, which would lose every model). Folders are new: a table of their own, and the folder of a model per person (the owner on the model, a member on
    /// their membership).
    /// </summary>
    public partial class ModelsAndFolders : Migration
    {
        private static readonly (string Table, string Old, string New)[] Constraints =
        [
            ("Model", "PK_Document", "PK_Model"),
            ("Model", "FK_Document_User_OwnerId", "FK_Model_User_OwnerId"),
            ("ModelMember", "PK_DocumentMember", "PK_ModelMember"),
            ("ModelMember", "FK_DocumentMember_Document_DocumentId", "FK_ModelMember_Model_ModelId"),
            ("ModelMember", "FK_DocumentMember_User_UserId", "FK_ModelMember_User_UserId"),
            ("ModelVersion", "PK_DocumentVersion", "PK_ModelVersion"),
            ("ModelVersion", "FK_DocumentVersion_Document_DocumentId", "FK_ModelVersion_Model_ModelId"),
            ("PartStudio", "FK_PartStudio_Document_DocumentId", "FK_PartStudio_Model_ModelId"),
        ];

        private static readonly (string Table, string Old, string New)[] Indexes =
        [
            ("Model", "IX_Document_OwnerId", "IX_Model_OwnerId"),
            ("Model", "IX_Document_ShareToken", "IX_Model_ShareToken"),
            ("ModelMember", "IX_DocumentMember_DocumentId_UserId", "IX_ModelMember_ModelId_UserId"),
            ("ModelMember", "IX_DocumentMember_UserId", "IX_ModelMember_UserId"),
            ("ModelVersion", "IX_DocumentVersion_DocumentId", "IX_ModelVersion_ModelId"),
            ("PartStudio", "IX_PartStudio_DocumentId_Position", "IX_PartStudio_ModelId_Position"),
        ];

        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.RenameTable(name: "Document", newName: "Model");
            migrationBuilder.RenameTable(name: "DocumentMember", newName: "ModelMember");
            migrationBuilder.RenameTable(name: "DocumentVersion", newName: "ModelVersion");

            migrationBuilder.RenameColumn(name: "DocumentId", table: "ModelMember", newName: "ModelId");
            migrationBuilder.RenameColumn(name: "DocumentId", table: "ModelVersion", newName: "ModelId");
            migrationBuilder.RenameColumn(name: "DocumentId", table: "PartStudio", newName: "ModelId");
            migrationBuilder.RenameColumn(name: "DocumentId", table: "AiRun", newName: "ModelId");

            foreach (var (table, from, to) in Constraints)
            {
                migrationBuilder.Sql($"ALTER TABLE \"{table}\" RENAME CONSTRAINT \"{from}\" TO \"{to}\";");
            }

            foreach (var (table, from, to) in Indexes)
            {
                migrationBuilder.RenameIndex(name: from, table: table, newName: to);
            }

            migrationBuilder.CreateTable(
                name: "Folder",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    OwnerId = table.Column<long>(type: "bigint", nullable: false),
                    ParentId = table.Column<long>(type: "bigint", nullable: true),
                    Name = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    CreateDate = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    CreateUserId = table.Column<long>(type: "bigint", nullable: true),
                    UpdateDate = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdateUserId = table.Column<long>(type: "bigint", nullable: true),
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Folder", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Folder_Folder_ParentId",
                        column: x => x.ParentId,
                        principalTable: "Folder",
                        principalColumn: "Id");
                    table.ForeignKey(
                        name: "FK_Folder_User_OwnerId",
                        column: x => x.OwnerId,
                        principalTable: "User",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(name: "IX_Folder_OwnerId_ParentId", table: "Folder", columns: ["OwnerId", "ParentId"]);
            migrationBuilder.CreateIndex(name: "IX_Folder_ParentId", table: "Folder", column: "ParentId");

            migrationBuilder.AddColumn<long>(name: "FolderId", table: "Model", type: "bigint", nullable: true);
            migrationBuilder.AddColumn<long>(name: "FolderId", table: "ModelMember", type: "bigint", nullable: true);
            migrationBuilder.CreateIndex(name: "IX_Model_FolderId", table: "Model", column: "FolderId");
            migrationBuilder.CreateIndex(name: "IX_ModelMember_FolderId", table: "ModelMember", column: "FolderId");
            migrationBuilder.AddForeignKey(
                name: "FK_Model_Folder_FolderId",
                table: "Model",
                column: "FolderId",
                principalTable: "Folder",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);
            migrationBuilder.AddForeignKey(
                name: "FK_ModelMember_Folder_FolderId",
                table: "ModelMember",
                column: "FolderId",
                principalTable: "Folder",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(name: "FK_Model_Folder_FolderId", table: "Model");
            migrationBuilder.DropForeignKey(name: "FK_ModelMember_Folder_FolderId", table: "ModelMember");
            migrationBuilder.DropIndex(name: "IX_Model_FolderId", table: "Model");
            migrationBuilder.DropIndex(name: "IX_ModelMember_FolderId", table: "ModelMember");
            migrationBuilder.DropColumn(name: "FolderId", table: "Model");
            migrationBuilder.DropColumn(name: "FolderId", table: "ModelMember");
            migrationBuilder.DropTable(name: "Folder");

            foreach (var (table, from, to) in Indexes)
            {
                migrationBuilder.RenameIndex(name: to, table: table, newName: from);
            }

            foreach (var (table, from, to) in Constraints)
            {
                migrationBuilder.Sql($"ALTER TABLE \"{table}\" RENAME CONSTRAINT \"{to}\" TO \"{from}\";");
            }

            migrationBuilder.RenameColumn(name: "ModelId", table: "AiRun", newName: "DocumentId");
            migrationBuilder.RenameColumn(name: "ModelId", table: "PartStudio", newName: "DocumentId");
            migrationBuilder.RenameColumn(name: "ModelId", table: "ModelVersion", newName: "DocumentId");
            migrationBuilder.RenameColumn(name: "ModelId", table: "ModelMember", newName: "DocumentId");

            migrationBuilder.RenameTable(name: "ModelVersion", newName: "DocumentVersion");
            migrationBuilder.RenameTable(name: "ModelMember", newName: "DocumentMember");
            migrationBuilder.RenameTable(name: "Model", newName: "Document");
        }
    }
}
