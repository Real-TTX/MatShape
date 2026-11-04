using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Html;

namespace MatShape.Services;

/// <summary>Small helpers for the markup of the toolkit: icons, the logo, initials.</summary>
public static partial class Ui
{
    public const string AppId = "matshape";
    public const string AppName = "MatShape";

    /// <summary>The accent: a fresh green in the family of the CAD tools on the web, but its own. Text on it is near black (7.3:1).</summary>
    public const string Accent = "#3cb764";

    [GeneratedRegex("^[a-z0-9-]+$")]
    private static partial Regex NameRegex();

    [GeneratedRegex("^#[0-9a-fA-F]{6}$")]
    private static partial Regex ColourRegex();

    /// <summary>An icon from the page's inline sprite (the toolkit's and the app's own).</summary>
    public static IHtmlContent Icon(string name, string? extraClass = null, string? colour = null)
    {
        if (!NameRegex().IsMatch(name))
        {
            throw new ArgumentException($"'{name}' is not an icon name.", nameof(name));
        }

        var cls = string.IsNullOrEmpty(extraClass) ? "mat-icon" : $"mat-icon {extraClass}";
        var data = IsColour(colour) ? $" data-colour=\"{colour}\"" : string.Empty;
        return new HtmlString($"<svg class=\"{cls}\"{data} aria-hidden=\"true\" focusable=\"false\"><use href=\"#mat-i-{name}\"></use></svg>");
    }

    public static bool IsColour(string? value) => value is not null && ColourRegex().IsMatch(value);

    /// <summary>The logo of the menu and the sign-in: the mark of MatShape (a cube on the accent).</summary>
    public static IHtmlContent Logo(string size = "md")
        => new HtmlString($"<span class=\"mat-logo mat-logo--{size} ms-logo\" role=\"img\" aria-label=\"{AppName}\"><svg class=\"mat-icon\" aria-hidden=\"true\" focusable=\"false\"><use href=\"#mat-i-matshape\"></use></svg></span>");

    public static string Initials(string name)
    {
        var letters = string.Concat(name.Split(' ', StringSplitOptions.RemoveEmptyEntries).Take(2).Select(p => char.ToUpperInvariant(p[0])));
        return letters.Length == 0 ? "?" : letters;
    }
}
