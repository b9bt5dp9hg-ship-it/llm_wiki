//! macOS instance ownership. The file lock, not the focus socket, owns the app.
use fs2::FileExt;
use std::{
    fs::{self, File, OpenOptions},
    io,
    os::{
        fd::AsRawFd,
        unix::{
            fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
            net::{UnixListener, UnixStream},
        },
    },
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

pub enum Instance {
    Primary(PrimaryInstance),
    Secondary,
}

pub struct PrimaryInstance {
    // Keep this descriptor open until application teardown. Never unlink it:
    // replacing a locked inode would let a second process acquire a new lock.
    _lock: File,
    pub listener: UnixListener,
    socket: PathBuf,
}

impl Drop for PrimaryInstance {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.socket);
    }
}

fn private_directory(directory: &Path) -> io::Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(directory)?;
    let metadata = fs::symlink_metadata(directory)?;
    if !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Instance directory must be private and owned by the current user",
        ));
    }
    Ok(())
}

pub fn claim(directory: &Path) -> io::Result<Instance> {
    private_directory(directory)?;
    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(directory.join("instance.lock"))?;
    let metadata = lock.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || metadata.nlink() != 1
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Unsafe instance lock file",
        ));
    }
    let socket = directory.join("focus.sock");
    match lock.try_lock_exclusive() {
        Ok(()) => {
            match fs::remove_file(&socket) {
                Ok(()) => (),
                Err(e) if e.kind() == io::ErrorKind::NotFound => (),
                Err(e) => return Err(e),
            }
            let listener = UnixListener::bind(&socket)?;
            fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;
            Ok(Instance::Primary(PrimaryInstance {
                _lock: lock,
                listener,
                socket,
            }))
        }
        Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
            // The owner may have acquired the lock just before binding its socket.
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                match UnixStream::connect(&socket) {
                    Ok(stream) => {
                        if !is_same_user(&stream) {
                            return Err(io::Error::new(
                                io::ErrorKind::PermissionDenied,
                                "Unexpected instance peer",
                            ));
                        }
                        // Connection alone requests focus. Never forward argv/cwd.
                        return Ok(Instance::Secondary);
                    }
                    Err(e)
                        if matches!(
                            e.kind(),
                            io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
                        ) && Instant::now() < deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(20))
                    }
                    Err(e) => return Err(e),
                }
            }
        }
        Err(e) => Err(e),
    }
}

pub fn is_same_user(stream: &UnixStream) -> bool {
    let (mut uid, mut gid) = (0, 0);
    unsafe {
        libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) == 0 && uid == libc::geteuid()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Barrier,
    };

    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct TestDir(std::path::PathBuf);
    impl TestDir {
        fn new() -> Self {
            Self(std::path::PathBuf::from(format!(
                "/tmp/wiki-si-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            )))
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn competing_launches_have_exactly_one_owner() {
        let dir = TestDir::new();
        let start = Arc::new(Barrier::new(12));
        let finish = Arc::new(Barrier::new(12));
        let threads: Vec<_> = (0..12)
            .map(|_| {
                let (path, start, finish) = (dir.0.clone(), start.clone(), finish.clone());
                std::thread::spawn(move || {
                    start.wait();
                    let instance = claim(&path).unwrap();
                    let owner = matches!(instance, Instance::Primary(_));
                    finish.wait();
                    drop(instance);
                    owner as usize
                })
            })
            .collect();
        assert_eq!(
            threads
                .into_iter()
                .map(|t| t.join().unwrap())
                .sum::<usize>(),
            1
        );
    }

    #[test]
    fn secondary_notifies_owner_without_sending_launch_arguments() {
        use std::io::Read;
        let dir = TestDir::new();
        let Instance::Primary(primary) = claim(&dir.0).unwrap() else {
            panic!("expected owner")
        };
        assert!(matches!(claim(&dir.0).unwrap(), Instance::Secondary));
        let (mut stream, _) = primary.listener.accept().unwrap();
        assert!(is_same_user(&stream));
        let mut payload = Vec::new();
        stream.read_to_end(&mut payload).unwrap();
        assert!(payload.is_empty());
    }

    #[test]
    fn releasing_owner_allows_restart_and_stale_socket_recovery() {
        let dir = TestDir::new();
        let first = claim(&dir.0).unwrap();
        drop(first);
        std::fs::write(dir.0.join("focus.sock"), b"stale").unwrap();
        assert!(matches!(claim(&dir.0).unwrap(), Instance::Primary(_)));
    }

    #[test]
    fn insecure_directory_and_symlink_are_rejected() {
        let dir = TestDir::new();
        std::fs::create_dir(&dir.0).unwrap();
        std::fs::set_permissions(&dir.0, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(claim(&dir.0).is_err());
        let link = TestDir::new();
        symlink(&dir.0, &link.0).unwrap();
        assert!(claim(&link.0).is_err());
        std::fs::remove_file(&link.0).unwrap();
    }

    #[test]
    fn lock_symlink_is_rejected() {
        let dir = TestDir::new();
        std::fs::create_dir(&dir.0).unwrap();
        std::fs::set_permissions(&dir.0, std::fs::Permissions::from_mode(0o700)).unwrap();
        symlink("/dev/null", dir.0.join("instance.lock")).unwrap();
        assert!(claim(&dir.0).is_err());
    }
}
