#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    CustomMenuItem, Manager, SystemTray, SystemTrayEvent, SystemTrayMenu, SystemTrayMenuItem,
    Window,
};

fn position_window_bottom_right(window: &Window) {
    if let Ok(Some(monitor)) = window.current_monitor() {
        let size = monitor.size();
        let scale = monitor.scale_factor();
        let win_w = 320.0_f64;
        let win_h = 380.0_f64;
        // 48px = typical Windows taskbar height
        let taskbar_h = 48.0_f64;
        let margin = 8.0_f64;
        let x = (size.width as f64 / scale) - win_w - margin;
        let y = (size.height as f64 / scale) - win_h - taskbar_h;
        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
    }
}

fn toggle_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_window("overlay") {
        match window.is_visible() {
            Ok(true) => {
                let _ = window.hide();
            }
            _ => {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    }
}

fn main() {
    let tray_menu = SystemTrayMenu::new()
        .add_item(CustomMenuItem::new("show_hide", "Show / Hide"))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(CustomMenuItem::new("today", "Open Dashboard"))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(CustomMenuItem::new("quit", "Quit"));

    let tray = SystemTray::new()
        .with_menu(tray_menu)
        .with_tooltip("Wasted Token Overlay — click to toggle");

    tauri::Builder::default()
        .system_tray(tray)
        .on_system_tray_event(|app, event| match event {
            SystemTrayEvent::LeftClick { .. } => toggle_window(app),
            SystemTrayEvent::DoubleClick { .. } => toggle_window(app),
            SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
                "show_hide" => toggle_window(app),
                "today" => {
                    // Open dashboard in default browser
                    let _ = tauri::api::shell::open(
                        &app.shell_scope(),
                        "http://127.0.0.1:3777",
                        None,
                    );
                }
                "quit" => {
                    app.exit(0);
                }
                _ => {}
            },
            _ => {}
        })
        .setup(|app| {
            let window = app.get_window("overlay").unwrap();
            position_window_bottom_right(&window);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
