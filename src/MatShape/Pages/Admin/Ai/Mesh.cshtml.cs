using MatShape.Controls;
using MatShape.Data;
using MatShape.Localization;
using MatShape.Services.Ai;
using Microsoft.AspNetCore.Mvc;

namespace MatShape.Pages.Admin.Ai;

/// <summary>
/// The 3D generation (Meshy): on or off, the key (write-only: it is stored encrypted outside the database and never shown again), the model, the triangles of a result and the limits
/// counted in generations; a test of the key. Administrators only (checked again in <see cref="MeshService"/>).
/// </summary>
public sealed class MeshModel(AppDbContext db) : AppPageModel
{
    [BindProperty] public bool Enabled { get; set; }

    [BindProperty] public string ApiKey { get; set; } = string.Empty;

    [BindProperty] public bool RemoveKey { get; set; }

    [BindProperty] public string BaseUrl { get; set; } = MeshyClient.DefaultBaseUrl;

    [BindProperty] public string Model { get; set; } = "latest";

    [BindProperty] public int Polycount { get; set; }

    [BindProperty] public int UserDaily { get; set; }

    [BindProperty] public int Monthly { get; set; }

    public bool HasKey { get; private set; }

    public int ThisMonth { get; private set; }

    public string? TestResult { get; private set; }

    public bool TestOk { get; private set; }

    public List<Choice> Models { get; } = [.. MeshyClient.Models.Select(m => new Choice(m, Text.T("Ai.Mesh.Model." + m)))];

    private AiContext Context => new(db, HttpContext.RequestServices, UserId);

    public async Task<IActionResult> OnGetAsync() => await LoadAsync(fillForm: true) ? Page() : Forbid();

    public async Task<IActionResult> OnPostAsync()
    {
        var input = new MeshSettings { Enabled = Enabled, BaseUrl = BaseUrl, Model = Model, Polycount = Polycount, UserDaily = UserDaily, Monthly = Monthly };
        var (denied, errors) = await MeshService.SaveAsync(Context, input, ApiKey, RemoveKey);
        if (denied)
        {
            return Forbid();
        }

        if (errors.Count > 0)
        {
            errors.ForEach(e => ModelState.AddModelError(e.Field, e.Message));
            await LoadAsync(fillForm: false);
            return Page();
        }

        Flash(Text.T("Common.Saved"));
        return LocalRedirect("/Admin/Ai/Mesh");
    }

    public async Task<IActionResult> OnPostTestAsync()
    {
        if (!await LoadAsync(fillForm: true))
        {
            return Forbid();
        }

        var test = await MeshService.TestAsync(Context);
        TestResult = test?.Text;
        TestOk = test?.Ok == true;
        return Page();
    }

    private async Task<bool> LoadAsync(bool fillForm)
    {
        if (await MeshService.AdminAsync(Context) is not { } admin)
        {
            return false;
        }

        HasKey = admin.HasKey;
        ThisMonth = admin.ThisMonth;
        if (fillForm)
        {
            var s = admin.Settings;
            Enabled = s.Enabled;
            BaseUrl = s.BaseUrl;
            Model = s.Model;
            Polycount = s.Polycount;
            UserDaily = s.UserDaily;
            Monthly = s.Monthly;
        }

        return true;
    }
}
