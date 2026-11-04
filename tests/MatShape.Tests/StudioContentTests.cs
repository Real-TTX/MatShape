using MatShape.Services.Documents;

namespace MatShape.Tests;

/// <summary>What the server lets into the database as the content of a Part Studio.</summary>
public sealed class StudioContentTests
{
    [Fact]
    public void The_empty_content_is_valid() => Assert.Null(StudioContent.Validate(StudioContent.Empty));

    [Fact]
    public void A_real_history_is_valid()
    {
        const string json = """
            {"features":[
              {"id":"s1","type":"sketch","name":"Sketch 1","params":{"plane":{"kind":"std","name":"top"},"entities":[{"id":"r","t":"rect","a":[0,0],"b":[10,5]}]}},
              {"id":"e1","type":"extrude","name":"Extrude 1","suppressed":false,"params":{"sketch":"s1","depth":"10","op":"new"}}
            ],"parts":{"e1":{"name":"Plate","color":"#9fb3c8"}},"rollback":null}
            """;
        Assert.Null(StudioContent.Validate(json));
        Assert.Equal(2, StudioContent.CountFeatures(json));
    }

    [Theory]
    [InlineData("")]
    [InlineData("not json")]
    [InlineData("[]")]
    [InlineData("""{"parts":{}}""")]
    [InlineData("""{"features":{}}""")]
    [InlineData("""{"features":[{"type":"sketch"}]}""")]
    [InlineData("""{"features":[{"id":"a","type":"virus"}]}""")]
    [InlineData("""{"features":[{"id":"a","type":"sketch"},{"id":"a","type":"sketch"}]}""")]
    [InlineData("""{"features":[{"id":"a","type":"sketch","params":[]}]}""")]
    [InlineData("""{"features":[],"parts":[]}""")]
    [InlineData("""{"features":[],"rollback":"x"}""")]
    public void Anything_else_is_refused(string json) => Assert.NotNull(StudioContent.Validate(json));

    [Fact]
    public void Too_much_is_refused()
    {
        var features = string.Join(',', Enumerable.Range(0, StudioContent.MaxFeatures + 1).Select(i => $$"""{"id":"f{{i}}","type":"variable"}"""));
        Assert.Equal("too many features", StudioContent.Validate($$"""{"features":[{{features}}]}"""));
        Assert.Equal("too large", StudioContent.Validate($$"""{"features":[],"x":"{{new string('a', StudioContent.MaxBytes)}}"}"""));
    }

    [Fact]
    public void Units_are_known()
    {
        Assert.True(DocumentUnits.IsUnit("in"));
        Assert.False(DocumentUnits.IsUnit("ft"));
        Assert.Equal(25.4, DocumentUnits.Millimetres("in"));
    }
}
