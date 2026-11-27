use std::{env, path::{Path, PathBuf}};

fn watch_dir(dir: &Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                watch_dir(&path);
            } else {
                println!("cargo:rerun-if-changed={}", path.display());
            }
        }
    }
}

fn main() {
    // Frontend synchronization is handled once by tauri.conf.json's
    // beforeBuildCommand. Keeping it out of build.rs avoids duplicate builds
    // and makes `cargo check` independent of Node.
    watch_dir(Path::new("../js"));
    watch_dir(Path::new("../css"));
    watch_dir(Path::new("../foliate-js-main"));
    println!("cargo:rerun-if-changed=../index.html");
    println!("cargo:rerun-if-changed=tauri.conf.json");

    println!("cargo:rustc-check-cfg=cfg(ll_mupdf)");
    println!("cargo:rerun-if-env-changed=LL_MUPDF_INCLUDE");
    println!("cargo:rerun-if-env-changed=LL_MUPDF_LIB_DIR");
    println!("cargo:rerun-if-env-changed=LL_MUPDF_ANDROID_LIB_DIR");
    println!("cargo:rerun-if-env-changed=LL_MUPDF_LIBS");
    println!("cargo:rerun-if-env-changed=LL_REQUIRE_NATIVE_MUPDF");
    println!("cargo:rerun-if-env-changed=LL_MUPDF_REQUIRED");
    println!("cargo:rerun-if-env-changed=LINDEN_NATIVE_CACHE_DIR");

    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let _is_target_windows = target_os == "windows" || (target_os.is_empty() && cfg!(windows));
    let is_target_android = target_os == "android";

    // NDK r26 defaults to 4 KiB ELF load segments.
    if is_target_android {
        println!("cargo:rustc-link-arg-cdylib=-Wl,-z,max-page-size=16384,-z,common-page-size=16384");
    }

    let require_native = (env::var("LL_REQUIRE_NATIVE_MUPDF").is_ok()
        || env::var("LL_MUPDF_REQUIRED").is_ok()) && !is_target_android;

    let include = env::var_os("LL_MUPDF_INCLUDE").map(PathBuf::from)
        .or_else(|| {
            let p = PathBuf::from("native/include");
            p.exists().then_some(p)
        });
    let lib_dir = env::var_os("LL_MUPDF_LIB_DIR").map(PathBuf::from)
        .or_else(|| {
            let p = PathBuf::from("native/lib");
            p.exists().then_some(p)
        });

    let lib_dir = if is_target_android {
        env::var_os("LL_MUPDF_ANDROID_LIB_DIR").map(PathBuf::from)
    } else {
        lib_dir
    };

    assert!(!is_target_android || lib_dir.is_none() || include.is_some(),
        "Android MuPDF libraries require LL_MUPDF_INCLUDE");
    if let (Some(include), Some(lib_dir)) = (include, lib_dir) {
        println!("cargo:rerun-if-changed=native/ll_mupdf.c");
        println!("cargo:rerun-if-changed=native/ll_mupdf.h");
        println!("cargo:rerun-if-changed=native/ll_mupdf_mobile.c");
        println!("cargo:rerun-if-changed=native/ll_mupdf_mobile.h");
        cc::Build::new()
            .file("native/ll_mupdf.c")
            .file("native/ll_mupdf_mobile.c")
            .include("native")
            .include(&include)
            .warnings(true)
            .compile("ll_mupdf_bridge");

        println!("cargo:rustc-link-search=native={}", lib_dir.display());
        let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
        let is_target_windows = target_os == "windows" || (target_os.is_empty() && cfg!(windows));
        let default_libs = if is_target_windows {
            "libmupdf;libthirdparty;libresources"
        } else {
            "mupdf"
        };
        let libs = env::var("LL_MUPDF_LIBS").unwrap_or_else(|_| default_libs.into());
        for lib in libs.split(|c| c == ';' || c == ',').map(str::trim).filter(|x| !x.is_empty()) {
            if require_native && is_target_windows {
                let candidate = lib_dir.join(format!("{lib}.lib"));
                if !candidate.exists() {
                    panic!("FATAL: Native MuPDF library file does not exist: {}", candidate.display());
                }
            }
            let library_file = if is_target_windows {
                lib_dir.join(format!("{lib}.lib"))
            } else {
                lib_dir.join(format!("lib{lib}.a"))
            };
            println!("cargo:rerun-if-changed={}", library_file.display());
            if is_target_android {
                assert!(library_file.is_file(), "Missing Android MuPDF archive: {}", library_file.display());
                println!("cargo:rustc-link-lib=static={lib}");
            } else {
                println!("cargo:rustc-link-lib={lib}");
            }
        }
        if is_target_android {
            for lib in ["c++_static", "c++abi", "log", "z", "m"] {
                println!("cargo:rustc-link-lib={lib}");
            }
        }
        println!("cargo:rustc-cfg=ll_mupdf");
        println!("cargo:warning=MuPDF native backend enabled");
    } else {
        if require_native {
            panic!("FATAL: Native MuPDF backend is strictly required (LL_REQUIRE_NATIVE_MUPDF=1), but LL_MUPDF_INCLUDE or LL_MUPDF_LIB_DIR is missing or invalid!");
        }
        println!("cargo:warning=MuPDF native backend disabled; set LL_MUPDF_INCLUDE and LL_MUPDF_LIB_DIR to enable it");
    }

    tauri_build::build();
}
