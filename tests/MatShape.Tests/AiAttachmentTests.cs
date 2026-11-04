using System.Text;
using MatShape.Services.Ai;

namespace MatShape.Tests;

/// <summary>What the modelling assistant takes as attachments: pictures and PDFs as files, SVGs as text; anything else, too many or too large is refused.</summary>
public sealed class AiAttachmentTests
{
    private static string B64(string text) => Convert.ToBase64String(Encoding.UTF8.GetBytes(text));

    private static readonly string Png = Convert.ToBase64String([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

    [Fact]
    public void No_attachments_is_fine()
    {
        var (files, svgs, problem) = ModelAssistant.ReadAttachments(null);
        Assert.Null(problem);
        Assert.Empty(files);
        Assert.Empty(svgs);
    }

    [Fact]
    public void Pictures_and_pdfs_become_files_and_svgs_text()
    {
        var (files, svgs, problem) = ModelAssistant.ReadAttachments([
            new("photo.png", "image/png", Png),
            new("drawing.pdf", "application/pdf", "data:application/pdf;base64," + B64("%PDF-1.4")),
            new("logo.svg", "image/svg+xml", B64("<svg><path d=\"M0 0h10v10z\"/></svg>")),
        ]);
        Assert.Null(problem);
        Assert.Equal(["image", "file"], files.Select(f => f.Kind));
        Assert.Equal(B64("%PDF-1.4"), files[1].Data);
        Assert.Contains("M0 0h10v10z", Assert.Single(svgs).Text);
    }

    [Theory]
    [InlineData("text/html")]
    [InlineData("application/x-msdownload")]
    [InlineData("")]
    public void Other_types_are_refused(string type) =>
        Assert.NotNull(ModelAssistant.ReadAttachments([new("x", type, Png)]).Problem);

    [Fact]
    public void Broken_base64_is_refused() =>
        Assert.NotNull(ModelAssistant.ReadAttachments([new("x.png", "image/png", "not base64 !!")]).Problem);

    [Fact]
    public void Too_many_are_refused() =>
        Assert.NotNull(ModelAssistant.ReadAttachments([.. Enumerable.Range(0, ModelAssistant.MaxAttachments + 1).Select(i => new ModelAssistant.Attachment($"{i}.png", "image/png", Png))]).Problem);

    [Fact]
    public void A_large_svg_is_refused() =>
        Assert.NotNull(ModelAssistant.ReadAttachments([new("big.svg", "image/svg+xml", B64(new string('a', ModelAssistant.MaxSvgBytes + 1)))]).Problem);
}
