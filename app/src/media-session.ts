import type { MusicPlayer } from "./music-player";

export interface MediaSessionAlbumInfo {
  title?: string;
  coverUrl?: string;
}

/**
 * System media keys and the OS media overlay through the Media Session API.
 * Works in plain browsers, so media-key support does not wait for an Electron shell.
 */
export function setupMediaSession(
  player: MusicPlayer,
  albumInfo: (albumId: string) => MediaSessionAlbumInfo | undefined,
): void {
  if (!("mediaSession" in navigator)) return;
  const session = navigator.mediaSession;
  session.setActionHandler("play", () => {
    if (!player.state.playing) void player.toggle();
  });
  session.setActionHandler("pause", () => {
    if (player.state.playing) void player.toggle();
  });
  session.setActionHandler("previoustrack", () => void player.previous());
  session.setActionHandler("nexttrack", () => void player.next());

  let lastPosition = -1;
  player.subscribe((state) => {
    const track = state.currentTrack;
    if (!track) {
      session.metadata = null;
      return;
    }
    const info = albumInfo(track.albumId);
    const album = info?.title ?? "";
    const current = session.metadata;
    if (
      !current ||
      current.title !== track.title ||
      current.artist !== track.artist ||
      current.album !== album
    ) {
      session.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album,
        artwork: info?.coverUrl ? [{ src: info.coverUrl }] : [],
      });
    }
    const position = Math.floor(state.currentTime);
    if (state.duration > 0 && position !== lastPosition) {
      lastPosition = position;
      try {
        session.setPositionState({
          duration: state.duration,
          position: Math.min(position, state.duration),
          playbackRate: 1,
        });
      } catch {
        // A browser may reject a position it considers out of range; the overlay still updates.
      }
    }
  });
}
