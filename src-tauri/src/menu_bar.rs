//! Native application menu bar (macOS-first).
//!
//! Gives Galeon a real system menu: App / File / Edit / View / Window / Help,
//! plus the product actions a desktop app is expected to expose. Every item
//! emits a `menu://…` event; the frontend listens and runs the real handler.
//! This file never calls the transfer, connect, or filesystem code itself.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Runtime,
};

pub const PREFERENCES_ID: &str = "preferences";
pub const PREFERENCES_EVENT: &str = "menu://preferences";

pub const UPLOAD_ID: &str = "upload";
pub const UPLOAD_EVENT: &str = "menu://upload";

pub const NEW_FOLDER_ID: &str = "new-folder";
pub const NEW_FOLDER_EVENT: &str = "menu://new-folder";

pub const DISCONNECT_ID: &str = "disconnect";
pub const DISCONNECT_EVENT: &str = "menu://disconnect";

pub const VIEW_LOCAL_PANE_ID: &str = "view-local-pane";
pub const VIEW_LOCAL_PANE_EVENT: &str = "menu://toggle-local-pane";

pub const COMMAND_PALETTE_ID: &str = "command-palette";
pub const COMMAND_PALETTE_EVENT: &str = "menu://command-palette";

pub const SYNC_ID: &str = "sync";
pub const SYNC_EVENT: &str = "menu://sync";

pub const LINKS_ID: &str = "links";
pub const LINKS_EVENT: &str = "menu://links";

pub const KEYBOARD_SHORTCUTS_ID: &str = "keyboard-shortcuts";
pub const KEYBOARD_SHORTCUTS_EVENT: &str = "menu://keyboard-shortcuts";

/// Build and install the app menu; wire every item → frontend event.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let pkg = app.package_info();
    let about = tauri::menu::AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        ..Default::default()
    };

    let preferences =
        MenuItem::with_id(app, PREFERENCES_ID, "Settings…", true, Some("CmdOrCtrl+,"))?;

    let upload = MenuItem::with_id(app, UPLOAD_ID, "Upload…", true, Some("CmdOrCtrl+Shift+U"))?;
    let new_folder = MenuItem::with_id(
        app,
        NEW_FOLDER_ID,
        "New Folder…",
        true,
        Some("CmdOrCtrl+Shift+N"),
    )?;
    let disconnect = MenuItem::with_id(app, DISCONNECT_ID, "Disconnect", true, None::<&str>)?;

    let toggle_local_pane = MenuItem::with_id(
        app,
        VIEW_LOCAL_PANE_ID,
        "Toggle Local Pane",
        true,
        Some("Alt+CmdOrCtrl+L"),
    )?;
    let command_palette = MenuItem::with_id(
        app,
        COMMAND_PALETTE_ID,
        "Command Palette",
        true,
        Some("CmdOrCtrl+K"),
    )?;
    let sync = MenuItem::with_id(app, SYNC_ID, "Sync…", true, None::<&str>)?;
    let links = MenuItem::with_id(app, LINKS_ID, "Shared Links", true, None::<&str>)?;

    // Help is where a user looks for the key map; ⌘/ is the shortcut every
    // keyboard-first app already teaches.
    let keyboard_shortcuts = MenuItem::with_id(
        app,
        KEYBOARD_SHORTCUTS_ID,
        "Keyboard Shortcuts",
        true,
        Some("CmdOrCtrl+/"),
    )?;

    #[cfg(target_os = "macos")]
    let app_submenu = Submenu::with_items(
        app,
        "Galeon",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Galeon"), Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &preferences,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let file_submenu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &upload,
            &new_folder,
            &PredefinedMenuItem::separator(app)?,
            &disconnect,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let edit_submenu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    #[cfg(target_os = "macos")]
    let view_submenu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &toggle_local_pane,
            &command_palette,
            &sync,
            &links,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    // Full Screen is a macOS concept; the product items are not.
    #[cfg(not(target_os = "macos"))]
    let view_submenu = Submenu::with_items(
        app,
        "View",
        true,
        &[&toggle_local_pane, &command_palette, &sync, &links],
    )?;

    let window_submenu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let help_submenu = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &keyboard_shortcuts,
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::separator(app)?,
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::about(app, Some("About Galeon"), Some(about))?,
        ],
    )?;

    let menu = Menu::with_items(
        app,
        &[
            #[cfg(target_os = "macos")]
            &app_submenu,
            &file_submenu,
            &edit_submenu,
            &view_submenu,
            &window_submenu,
            &help_submenu,
        ],
    )?;

    app.set_menu(menu)?;

    app.on_menu_event(|app, event| {
        let event_name = match event.id().as_ref() {
            PREFERENCES_ID => PREFERENCES_EVENT,
            UPLOAD_ID => UPLOAD_EVENT,
            NEW_FOLDER_ID => NEW_FOLDER_EVENT,
            DISCONNECT_ID => DISCONNECT_EVENT,
            VIEW_LOCAL_PANE_ID => VIEW_LOCAL_PANE_EVENT,
            COMMAND_PALETTE_ID => COMMAND_PALETTE_EVENT,
            SYNC_ID => SYNC_EVENT,
            LINKS_ID => LINKS_EVENT,
            KEYBOARD_SHORTCUTS_ID => KEYBOARD_SHORTCUTS_EVENT,
            _ => return,
        };
        let _ = app.emit(event_name, ());
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_events_are_unique() {
        let events = [
            PREFERENCES_EVENT,
            UPLOAD_EVENT,
            NEW_FOLDER_EVENT,
            DISCONNECT_EVENT,
            VIEW_LOCAL_PANE_EVENT,
            COMMAND_PALETTE_EVENT,
            SYNC_EVENT,
            LINKS_EVENT,
            KEYBOARD_SHORTCUTS_EVENT,
        ];
        let mut seen = std::collections::BTreeSet::new();
        for event in events {
            assert!(event.starts_with("menu://"), "{event}");
            assert!(seen.insert(event), "duplicate {event}");
        }
    }
}
