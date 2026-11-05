namespace MatShape.Services;

/// <summary>
/// The keyboard shortcuts of the editor, the way OnShape has them (Shift+S sketch, Shift+E extrude, Shift+W revolve, Shift+F fillet, Shift+1 … 7 the named views, arrows turn the view,
/// P the planes, N normal to the sketch, L / G / C / A / Q / H / V in a sketch, ? this list). The list of the dialog "?" and of the About page; the keys themselves are handled
/// in <c>wwwroot/js/cad/app.js</c> (keep the two in step). <see cref="Key.Text"/> is a key of the catalog under <c>Keys.</c>.
/// </summary>
public static class KeyMap
{
    public sealed record Key(string Keys, string Text);

    public sealed record Group(string Name, IReadOnlyList<Key> Keys);

    public static readonly IReadOnlyList<Group> Groups =
    [
        new("Features",
        [
            new("Shift+S", "Sketch"), new("Shift+E", "Extrude"), new("Shift+W", "Revolve"), new("Shift+F", "Fillet"), new("Enter", "Accept"), new("Esc", "Cancel"),
            new("Ctrl+Z", "Undo"), new("Ctrl+Y / Ctrl+Shift+Z", "Redo"), new("M", "Measure"),
        ]),
        new("View",
        [
            new("F", "Fit"), new("Shift+7", "Iso"), new("Shift+1", "Front"), new("Shift+2", "Back"), new("Shift+3", "Left"), new("Shift+4", "Right"),
            new("Shift+5", "Top"), new("Shift+6", "Bottom"), new("← → ↑ ↓", "Rotate15"), new("Shift+← → ↑ ↓", "Rotate90"), new("Alt+← →", "Roll"),
            new("N", "NormalTo"), new("P", "Planes"),
        ]),
        new("Sketching",
        [
            new("L", "Line"), new("G", "Rect"), new("C", "Circle"), new("A", "Arc"), new("D", "Dimension"), new("U", "Use"), new("M", "Trim"), new("O", "Offset"), new("T", "TangentArc"), new("Q", "Construction"), new("I", "Coincident"), new("H", "Horizontal"), new("V", "Vertical"),
            new("Ctrl+A", "SelectAll"), new("Del", "Delete"), new("Esc", "SketchEscape"), new("Enter", "FinishSketch"),
        ]),
        new("General", [new("?", "Help")]),
    ];
}
