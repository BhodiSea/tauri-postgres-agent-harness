// Embeds a custom Windows application manifest. Replacing the default
// manifest means we must re-declare everything it provided (Common Controls
// v6 + asInvoker execution level) alongside our addition:
// longPathAware lifts the 260-char MAX_PATH limit for Win32 path APIs —
// enterprise roaming profiles and deep install paths exceed it routinely.
// SOURCE: tauri_build::WindowsAttributes::app_manifest (verified 2.6.3) +
// Windows longPathAware application-manifest setting [corpus: tauri/windows-longpath]

#[allow(clippy::expect_used)] // build scripts fail by panicking; cargo surfaces the message
fn main() {
    let manifest = include_str!("windows-app-manifest.xml");
    let windows = tauri_build::WindowsAttributes::new().app_manifest(manifest);
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("tauri-build failed");
}
