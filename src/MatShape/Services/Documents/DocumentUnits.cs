namespace MatShape.Services.Documents;

/// <summary>The length units of a document. Inside, every length is millimetres; the unit says what a plain number in a field means and how lengths are shown.</summary>
public static class DocumentUnits
{
    public const string Default = "mm";

    public static readonly IReadOnlyList<string> All = ["mm", "cm", "m", "in"];

    public static bool IsUnit(string? unit) => unit is not null && All.Contains(unit);

    /// <summary>How many millimetres one unit is.</summary>
    public static double Millimetres(string unit) => unit switch
    {
        "cm" => 10,
        "m" => 1000,
        "in" => 25.4,
        _ => 1,
    };
}
