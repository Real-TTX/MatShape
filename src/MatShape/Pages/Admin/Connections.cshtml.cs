namespace MatShape.Pages.Admin;

/// <summary>
/// The connections of MatShape to other apps (the Mat app model): the Connections area of every app (<c>&lt;mat-connections /&gt;</c> of MatPlatform: what MatShape
/// uses, how each was set, what it adds to a home screen). MatShape uses the sign-in of MatIdentity and the mail of MatSMTP, which their variables set; a broker such
/// as Mattiverse sets them by itself. Like every page under /Admin it is for administrators (the policy AdminOnly), and so is its form
/// (<c>MatPlatformOptions.ConnectionsAccess</c> in Program.cs).
/// </summary>
public sealed class ConnectionsModel : AppPageModel
{
}
