#!/bin/sh
set -eu

JSON_C_VERSION=0.17
JSON_C_URL=https://github.com/json-c/json-c/archive/refs/tags/json-c-0.17-20230812.tar.gz
JSON_C_SHA256=024d302a3aadcbf9f78735320a6d5aedf8b77876c8ac8bbb95081ca55054c7eb
LIBUV_VERSION=1.44.2
LIBUV_URL=https://github.com/libuv/libuv/archive/refs/tags/v1.44.2.tar.gz
LIBUV_SHA256=e6e2ba8b4c349a4182a33370bb9be5e23c51b32efb9b9e209d0e8556b73a48da
MBEDTLS_VERSION=2.28.10
MBEDTLS_URL=https://github.com/Mbed-TLS/mbedtls/releases/download/mbedtls-2.28.10/mbedtls-2.28.10.tar.bz2
MBEDTLS_SHA256=19e5b81fdac0fe22009b9e2bdcd52d7dcafbf62bc67fc59cf0a76b5b5540d149
LIBWEBSOCKETS_VERSION=4.3.3
LIBWEBSOCKETS_URL=https://github.com/warmcat/libwebsockets/archive/refs/tags/v4.3.3.tar.gz
LIBWEBSOCKETS_SHA256=6fd33527b410a37ebc91bb64ca51bdabab12b076bc99d153d7c5dd405e4bdf90
TTYD_VERSION=1.7.7
TTYD_URL=https://github.com/tsl0922/ttyd/archive/refs/tags/1.7.7.tar.gz
TTYD_SHA256=039dd995229377caee919898b7bd54484accec3bba49c118e2d5cd6ec51e3650
MACOSX_DEPLOYMENT_TARGET=12.0
export MACOSX_DEPLOYMENT_TARGET

usage() {
    printf 'Usage: sh scripts/build-ttyd-macos.sh <work-directory> <output-directory>\n\n'
    printf 'Requires macOS, Xcode Command Line Tools, and CMake. No packages are installed.\n'
    printf 'The work directory is for this build only; src/, build/, stage/, and package/ are replaced.\n\n'
    printf 'Example: sh scripts/build-ttyd-macos.sh /tmp/ttyd-work dist\n'
}

fail() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

if [ "$#" -eq 1 ] && [ "$1" = --help ]; then
    usage
    exit 0
fi
[ "$#" -eq 2 ] || { usage >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || fail 'This script must run on macOS.'
for tool in cmake curl tar shasum xcrun lipo otool strip codesign awk sed sysctl; do
    command -v "$tool" >/dev/null 2>&1 || fail "Missing tool: $tool"
done

mkdir -p "$1" "$2"
WORK=$(cd "$1" && pwd -P)
OUT=$(cd "$2" && pwd -P)
[ "$WORK" != / ] && [ "$OUT" != / ] || fail 'Do not use / as a build or output directory.'
case "$OUT/" in
    "$WORK/"|"$WORK/src/"*|"$WORK/build/"*|"$WORK/stage/"*|"$WORK/package/"*)
        fail 'Use a separate output directory, outside the work directories that are replaced.' ;;
esac
SRC="$WORK/src"
BUILD="$WORK/build"
STAGE="$WORK/stage"
DOWNLOADS="$WORK/downloads"
BUNDLE="ttyd-$TTYD_VERSION-macos-universal"
PACKAGE="$WORK/package/$BUNDLE"
SDK=$(xcrun --sdk macosx --show-sdk-path)
CC=$(xcrun --find clang)
JOBS=$(sysctl -n hw.ncpu)
ZLIB_LIBRARY="$SDK/usr/lib/libz.1.tbd"
[ -f "$ZLIB_LIBRARY" ] || fail "Missing macOS SDK zlib stub: $ZLIB_LIBRARY"
mkdir -p "$DOWNLOADS" "$WORK/tmp"
export TMPDIR="$WORK/tmp"
export PKG_CONFIG_PATH="$STAGE/lib/pkgconfig"
export PKG_CONFIG_LIBDIR="$STAGE/lib/pkgconfig"
unset CFLAGS CXXFLAGS CPPFLAGS LDFLAGS CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH LIBRARY_PATH

# 檢查同時有 arm64 和 x86_64(用 -archs 列出來比對;有些版本的 lipo,-verify_arch 一次只能驗一個架構)
is_universal() {
    archs=" $(lipo -archs "$1" 2>/dev/null) "
    case "$archs" in *" arm64 "*) ;; *) return 1 ;; esac
    case "$archs" in *" x86_64 "*) ;; *) return 1 ;; esac
}

fetch_source() {
    name=$1
    url=$2
    expected=$3
    archive="$DOWNLOADS/$name"
    if [ ! -f "$archive" ]; then
        printf '\n=== Downloading %s\n' "$url"
        curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fLSs \
            --retry 4 --connect-timeout 30 --max-time 600 \
            "$url" -o "$archive.part" || fail "Download failed: $url"
        mv "$archive.part" "$archive"
    fi
    actual=$(shasum -a 256 "$archive" | awk '{print $1}')
    [ "$actual" = "$expected" ] || fail "SHA-256 mismatch for $name: expected $expected, got $actual"
    printf 'SHA-256 OK: %s  %s\n' "$actual" "$name"
}

extract_source() {
    mkdir -p "$SRC/$1"
    tar -xf "$DOWNLOADS/$2" -C "$SRC/$1" --strip-components=1
}

configure() {
    component=$1
    shift
    printf '\n=== Configuring %s (arm64 + x86_64, macOS %s)\n' "$component" "$MACOSX_DEPLOYMENT_TARGET"
    cmake -S "$SRC/$component" -B "$BUILD/$component" -G 'Unix Makefiles' \
        -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_C_COMPILER="$CC" \
        -DCMAKE_MAKE_PROGRAM=/usr/bin/make \
        '-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64' \
        -DCMAKE_OSX_DEPLOYMENT_TARGET="$MACOSX_DEPLOYMENT_TARGET" \
        -DCMAKE_OSX_SYSROOT="$SDK" \
        -DCMAKE_INSTALL_PREFIX="$STAGE" \
        -DCMAKE_INSTALL_LIBDIR=lib \
        -DCMAKE_PREFIX_PATH="$STAGE" \
        -DCMAKE_FIND_ROOT_PATH="$STAGE" \
        -DCMAKE_FIND_ROOT_PATH_MODE_PROGRAM=NEVER \
        -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=ONLY \
        -DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=ONLY \
        -DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=ONLY \
        -DCMAKE_FIND_FRAMEWORK=NEVER \
        -DCMAKE_FIND_APPBUNDLE=NEVER \
        -DCMAKE_FIND_USE_PACKAGE_REGISTRY=OFF \
        -DCMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY=OFF \
        -DCMAKE_FIND_USE_CMAKE_ENVIRONMENT_PATH=OFF \
        '-DCMAKE_IGNORE_PREFIX_PATH=/opt/homebrew;/usr/local' \
        -DCMAKE_C_FLAGS= \
        '-DCMAKE_C_FLAGS_RELEASE=-Os -DNDEBUG' \
        -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
        -DBUILD_SHARED_LIBS=OFF \
        -DBUILD_TESTING=OFF \
        "$@"
}

build_install() {
    cmake --build "$BUILD/$1" --parallel "$JOBS"
    cmake --install "$BUILD/$1"
}

fetch_source "json-c-$JSON_C_VERSION.tar.gz" "$JSON_C_URL" "$JSON_C_SHA256"
fetch_source "libuv-v$LIBUV_VERSION.tar.gz" "$LIBUV_URL" "$LIBUV_SHA256"
fetch_source "mbedtls-$MBEDTLS_VERSION.tar.bz2" "$MBEDTLS_URL" "$MBEDTLS_SHA256"
fetch_source "libwebsockets-$LIBWEBSOCKETS_VERSION.tar.gz" "$LIBWEBSOCKETS_URL" "$LIBWEBSOCKETS_SHA256"
fetch_source "ttyd-$TTYD_VERSION.tar.gz" "$TTYD_URL" "$TTYD_SHA256"

rm -rf "$SRC" "$BUILD" "$STAGE" "$WORK/package"
mkdir -p "$SRC" "$BUILD" "$STAGE/lib" "$STAGE/include" "$PACKAGE"
extract_source json-c "json-c-$JSON_C_VERSION.tar.gz"
extract_source libuv "libuv-v$LIBUV_VERSION.tar.gz"
extract_source mbedtls "mbedtls-$MBEDTLS_VERSION.tar.bz2"
extract_source libwebsockets "libwebsockets-$LIBWEBSOCKETS_VERSION.tar.gz"
extract_source ttyd "ttyd-$TTYD_VERSION.tar.gz"

configure json-c -DDISABLE_THREAD_LOCAL_STORAGE=ON
build_install json-c

configure libuv -DLIBUV_BUILD_SHARED=OFF -DLIBUV_BUILD_TESTS=OFF -DLIBUV_BUILD_BENCH=OFF
# libuv 1.44.2 defines uv and uv_a unconditionally; build and stage only uv_a.
cmake --build "$BUILD/libuv" --target uv_a --parallel "$JOBS"
cp "$BUILD/libuv/libuv_a.a" "$STAGE/lib/libuv.a"
cp -R "$SRC/libuv/include/." "$STAGE/include/"

configure mbedtls -DENABLE_TESTING=OFF -DENABLE_PROGRAMS=OFF \
    -DUSE_SHARED_MBEDTLS_LIBRARY=OFF -DUSE_STATIC_MBEDTLS_LIBRARY=ON \
    -DMBEDTLS_FATAL_WARNINGS=OFF
build_install mbedtls

# Export only the static libwebsockets target and omit OpenSSL discovery.
sed 's/ websockets_shared//g' "$SRC/libwebsockets/cmake/libwebsockets-config.cmake.in" \
    > "$SRC/libwebsockets/cmake/libwebsockets-config.cmake.in.tmp"
mv "$SRC/libwebsockets/cmake/libwebsockets-config.cmake.in.tmp" \
    "$SRC/libwebsockets/cmake/libwebsockets-config.cmake.in"
sed -e 's/ OR PC_OPENSSL_FOUND//g' -e '/PC_OPENSSL/d' \
    "$SRC/libwebsockets/lib/tls/CMakeLists.txt" > "$SRC/libwebsockets/lib/tls/CMakeLists.txt.tmp"
mv "$SRC/libwebsockets/lib/tls/CMakeLists.txt.tmp" "$SRC/libwebsockets/lib/tls/CMakeLists.txt"

configure libwebsockets \
    -DLWS_WITHOUT_TESTAPPS=ON \
    -DLWS_WITH_MBEDTLS=ON \
    -DLWS_WITH_LIBUV=ON \
    -DLWS_WITH_EVLIB_PLUGINS=OFF \
    -DLWS_STATIC_PIC=ON \
    -DLWS_WITH_STATIC=ON \
    -DLWS_WITH_SHARED=OFF \
    -DLWS_UNIX_SOCK=ON \
    -DLWS_IPV6=ON \
    -DLWS_ROLE_RAW_FILE=OFF \
    -DLWS_WITH_HTTP2=ON \
    -DLWS_WITH_HTTP_BASIC_AUTH=OFF \
    -DLWS_WITH_UDP=OFF \
    -DLWS_WITHOUT_CLIENT=ON \
    -DLWS_WITHOUT_EXTENSIONS=OFF \
    -DLWS_WITH_LEJP=OFF \
    -DLWS_WITH_LEJP_CONF=OFF \
    -DLWS_WITH_LWSAC=OFF \
    -DLWS_WITH_SEQUENCER=OFF \
    -DDISABLE_WERROR=ON \
    -DLWS_LIBUV_INCLUDE_DIRS="$STAGE/include" \
    -DLWS_LIBUV_LIBRARIES="$STAGE/lib/libuv.a" \
    -DLWS_MBEDTLS_INCLUDE_DIRS="$STAGE/include" \
    "-DLWS_MBEDTLS_LIBRARIES=$STAGE/lib/libmbedtls.a;$STAGE/lib/libmbedx509.a;$STAGE/lib/libmbedcrypto.a" \
    -DMBEDTLS_LIBRARY="$STAGE/lib/libmbedtls.a" \
    -DMBEDX509_LIBRARY="$STAGE/lib/libmbedx509.a" \
    -DMBEDCRYPTO_LIBRARY="$STAGE/lib/libmbedcrypto.a" \
    -DZLIB_LIBRARY="$ZLIB_LIBRARY" \
    -DZLIB_INCLUDE_DIR="$SDK/usr/include"
build_install libwebsockets

for library in libjson-c.a libuv.a libmbedtls.a libmbedx509.a libmbedcrypto.a libwebsockets.a; do
    [ -f "$STAGE/lib/$library" ] || fail "Missing static library: $library"
    is_universal "$STAGE/lib/$library" || fail "Not universal: $library"
done
if find "$STAGE" -name '*.dylib' -print | grep -q .; then
    fail 'A third-party dynamic library was installed in stage.'
fi

configure ttyd \
    -DLibwebsockets_DIR="$STAGE/lib/cmake/libwebsockets" \
    -DLIBUV_INCLUDE_DIR="$STAGE/include" \
    -DLIBUV_LIBRARY="$STAGE/lib/libuv.a" \
    -DJSON-C_INCLUDE_DIR="$STAGE/include/json-c" \
    -DJSON-C_LIBRARY="$STAGE/lib/libjson-c.a" \
    -DZLIB_LIBRARY="$ZLIB_LIBRARY" \
    -DZLIB_INCLUDE_DIR="$SDK/usr/include" \
    '-DCMAKE_C_FLAGS=-Os -ffunction-sections -fdata-sections -fno-unwind-tables -fno-asynchronous-unwind-tables -flto' \
    -DCMAKE_EXE_LINKER_FLAGS=-Wl,-dead_strip
build_install ttyd
cp "$STAGE/bin/ttyd" "$OUT/ttyd"
strip -x "$OUT/ttyd"
codesign --force --sign - "$OUT/ttyd"

printf '\n=== Self-check: universal architectures\n'
lipo -archs "$OUT/ttyd"
is_universal "$OUT/ttyd" || fail 'ttyd must contain arm64 and x86_64.'

printf '\n=== Self-check: system libraries only (both architectures)\n'
otool -arch all -L "$OUT/ttyd" > "$WORK/dependencies.txt"
awk '{print}' "$WORK/dependencies.txt"
awk '
    /^[[:space:]]/ {
        count++
        if ($1 !~ /^\/usr\/lib\// && $1 !~ /^\/System\/Library\//) {
            print "Unexpected dependency: " $1 > "/dev/stderr"
            bad = 1
        }
    }
    END { exit (bad || count == 0) }
' "$WORK/dependencies.txt" || fail 'ttyd links a non-system dynamic library.'

printf '\n=== Self-check: minimum macOS version\n'
for architecture in arm64 x86_64; do
    otool -arch "$architecture" -l "$OUT/ttyd" > "$WORK/load-commands-$architecture.txt"
    awk -v architecture="$architecture" '
        $1 == "cmd" { build_version = ($2 == "LC_BUILD_VERSION") }
        build_version && ($1 == "platform" || $1 == "minos" || $1 == "sdk") {
            print architecture ": " $0
        }
        build_version && $1 == "platform" && $2 != "1" { bad = 1 }
        build_version && $1 == "minos" {
            count++
            if ($2 != "12.0" && $2 != "12.0.0") bad = 1
        }
        END { exit (bad || count != 1) }
    ' "$WORK/load-commands-$architecture.txt" || fail "Expected macOS 12.0 for $architecture."
done

printf '\n=== Self-check: ttyd version\n'
version=$("$OUT/ttyd" --version) || fail 'ttyd --version failed.'
printf '%s\n' "$version"
# 從原始碼壓縮檔(不是 git repo)編譯時,ttyd 會在版本後面加上 -unknown
printf '%s\n' "$version" | grep -Eq '^ttyd version 1\.7\.7(-unknown)?$' || fail 'Expected ttyd version 1.7.7.'

printf '\n=== Self-check: ad-hoc signature\n'
codesign -v "$OUT/ttyd" || fail 'Code signature verification failed.'
printf 'PASS: codesign -v\n'

mkdir -p "$OUT/LICENSES"
cp "$SRC/ttyd/LICENSE" "$OUT/LICENSES/ttyd-MIT.txt"
cp "$SRC/libwebsockets/LICENSE" "$OUT/LICENSES/libwebsockets-LICENSE.txt"
cp "$SRC/json-c/COPYING" "$OUT/LICENSES/json-c-MIT.txt"
cp "$SRC/libuv/LICENSE" "$OUT/LICENSES/libuv-MIT.txt"
cp "$SRC/mbedtls/LICENSE" "$OUT/LICENSES/mbedtls-LICENSE.txt"
ZLIB_VERSION=$(awk '$1 == "#define" && $2 == "ZLIB_VERSION" { gsub(/"/, "", $3); print $3 }' "$SDK/usr/include/zlib.h")
{
    printf 'ttyd %s for macOS (universal: arm64 + x86_64)\n' "$TTYD_VERSION"
    printf 'Minimum macOS version: %s (both architectures)\n' "$MACOSX_DEPLOYMENT_TARGET"
    printf 'Third-party libraries are static; only macOS system libraries are dynamic.\n'
    printf 'Signature: ad-hoc (not Developer ID signed or notarized).\n'
    printf 'Build script: scripts/build-ttyd-macos.sh\n'
    printf 'CMake: %s\n' "$(cmake --version | awk 'NR == 1 { print }')"
    printf 'Compiler: %s\n' "$("$CC" --version | awk 'NR == 1 { print }')"
    printf 'macOS SDK: %s\n\n' "$(xcrun --sdk macosx --show-sdk-version)"
    printf 'Component: json-c\nVersion: %s\nSource: %s\nSHA-256: %s\nLicense: MIT\n\n' "$JSON_C_VERSION" "$JSON_C_URL" "$JSON_C_SHA256"
    printf 'Component: libuv\nVersion: %s\nSource: %s\nSHA-256: %s\nLicense: MIT\n\n' "$LIBUV_VERSION" "$LIBUV_URL" "$LIBUV_SHA256"
    printf 'Component: Mbed TLS\nVersion: %s\nSource: %s\nSHA-256: %s\nLicense: Apache-2.0 (chosen from the upstream dual license)\n' "$MBEDTLS_VERSION" "$MBEDTLS_URL" "$MBEDTLS_SHA256"
    printf 'Checksum: matches the official release checksum and mbedtls-2.28.10-sha256sum.txt.\n'
    printf 'Security status: 2.28.10 is the final, end-of-life 2.28 LTS release.\n\n'
    printf 'Component: libwebsockets\nVersion: %s\nSource: %s\nSHA-256: %s\nLicense: MIT, with additional notices in LICENSES/libwebsockets-LICENSE.txt\n\n' "$LIBWEBSOCKETS_VERSION" "$LIBWEBSOCKETS_URL" "$LIBWEBSOCKETS_SHA256"
    printf 'Component: ttyd\nVersion: %s\nSource: %s\nSHA-256: %s\nLicense: MIT\n\n' "$TTYD_VERSION" "$TTYD_URL" "$TTYD_SHA256"
    printf 'Component: zlib (macOS system library)\nVersion: %s (SDK header)\nSource: macOS SDK; runtime /usr/lib/libz.1.dylib\nSHA-256: N/A (provided by macOS, no source archive downloaded)\n\n' "$ZLIB_VERSION"
    printf 'GitHub tag archive checksums are pinned from downloaded archive bytes; no upstream checksum claim is made for them.\n'
    printf 'Source adjustments: libwebsockets exports only websockets, omits PC_OPENSSL discovery, and embeds libuv rather than loading an event-loop plugin.\n'
} > "$OUT/BUILD-INFO.txt"

cp -p "$OUT/ttyd" "$OUT/BUILD-INFO.txt" "$PACKAGE/"
cp -R "$OUT/LICENSES" "$PACKAGE/"
COPYFILE_DISABLE=1 tar -czf "$OUT/$BUNDLE.tar.gz" -C "$WORK/package" "$BUNDLE"
printf '\n=== Output\n'
ls -lh "$OUT/$BUNDLE.tar.gz"
shasum -a 256 "$OUT/$BUNDLE.tar.gz"
