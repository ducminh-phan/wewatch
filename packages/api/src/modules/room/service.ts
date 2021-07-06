import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { InjectModel } from "@nestjs/mongoose";
import { SchedulerRegistry } from "@nestjs/schedule";
import { FilterQuery, Model } from "mongoose";
import { nanoid } from "nanoid";

import {
  RoomActionDTO as ActionDTO,
  roomActions as actions,
} from "@/actions/room";
import { MemberEventPayload } from "@/constants";
import { MemberDTO } from "@/schemas/member";
import { VideoDTO } from "@/schemas/room";
import { TypeWithSchema } from "@/schemas/utils";
import { UserDocument } from "modules/user";

import { Member, MemberDocument } from "./models/member";
import {
  PlaylistDocument,
  Room,
  RoomDocument,
  VideoDocument,
} from "./models/room";

@Injectable()
export class RoomService {
  constructor(
    @InjectModel(Room.name) private roomModel: Model<RoomDocument>,
    @InjectModel(Member.name) private memberModel: Model<MemberDocument>,
    private eventEmitter: EventEmitter2,
    private schedulerRegistry: SchedulerRegistry,
  ) {}

  async create(): Promise<RoomDocument> {
    const room = new this.roomModel({
      playlists: [
        {
          name: nanoid(10),
          videos: [
            {
              url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
              title: "Rick Astley - Never Gonna Give You Up (Video)",
              thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
            },
            {
              url: "https://www.youtube.com/watch?v=YuBeBjqKSGQ",
              title:
                "The Magic Flute – Queen of the Night aria (Mozart; Diana Damrau, The Royal Opera)",
              thumbnailUrl: "https://i.ytimg.com/vi/YuBeBjqKSGQ/hqdefault.jpg",
            },
          ],
        },
      ],
    });

    return await room.save();
  }

  async get(id: string): Promise<RoomDocument | null> {
    return this.roomModel.findById(id).exec();
  }

  async getRoom(roomId: string): Promise<RoomDocument> {
    const room = await this.get(roomId);
    if (room === null) {
      throw new NotFoundException("Room not found");
    }

    return room;
  }

  async getMembers<B extends boolean>(
    roomId: string,
    populate: B,
    additionalFilter: FilterQuery<MemberDocument> = {},
  ): Promise<
    B extends true ? (MemberDocument & MemberDTO)[] : MemberDocument[]
  > {
    let query = this.memberModel.find({
      room: roomId,
      ...additionalFilter,
    });

    if (populate) {
      query = query.populate("user");
    }

    return (await query.exec()) as never;
  }

  async handleUserJoinRoom(roomId: string, user: UserDocument): Promise<void> {
    const room = await this.getRoom(roomId);
    await this.memberModel
      .findOneAndUpdate(
        {
          room: room.id,
          user: user.id,
        },
        {
          online: true,
        },
        {
          upsert: true,
        },
      )
      .exec();
  }

  async handleUserLeaveRoom(roomId: string, userId: string): Promise<void> {
    await this.memberModel
      .findOneAndUpdate(
        {
          room: roomId,
          user: userId,
        },
        {
          online: false,
        },
      )
      .exec();
  }

  async handleMemberEvent(
    roomId: string,
    userId: string,
    payload: MemberEventPayload,
  ): Promise<void> {
    if (payload === MemberEventPayload.ReadyToNext) {
      await this.handleMemberReadyToNext(roomId, userId);
    }
  }

  async handleMemberReadyToNext(roomId: string, userId: string): Promise<void> {
    const member = await this.memberModel
      .findOneAndUpdate(
        {
          room: roomId,
          user: userId,
        },
        {
          readyToNext: true,
        },
      )
      .exec();
    if (member === null) {
      return;
    }

    const timeoutName = `selectAndPlayNextVideo:${roomId}`;

    const members = await this.getMembers(roomId, false);
    if (members.every((m) => m.readyToNext)) {
      if (this.schedulerRegistry.doesExists("timeout", timeoutName)) {
        this.schedulerRegistry.deleteTimeout(timeoutName);
      }

      return await this.selectAndPlayNextVideo(roomId);
    }

    const isFirstReadyMember =
      members.filter((m) => m.readyToNext).length === 1;
    if (isFirstReadyMember) {
      const timeout = setTimeout(
        this.selectAndPlayNextVideo.bind(this),
        5000,
        roomId,
      );
      this.schedulerRegistry.addTimeout(timeoutName, timeout);
    }
  }

  async selectAndPlayNextVideo(roomId: string): Promise<void> {
    const nextVideoURL = await this.selectNextVideo(roomId);

    let action: ActionDTO;
    if (nextVideoURL === null) {
      action = actions.setPlaying(false);
    } else {
      action = actions.setActiveURL(nextVideoURL);
    }

    await this.handleAction(roomId, action);

    this.eventEmitter.emit("room.actions", {
      roomId,
      action,
    });

    await this.memberModel
      .updateMany(
        {
          room: roomId,
        },
        {
          readyToNext: false,
        },
      )
      .exec();
  }

  async selectNextVideo(roomId: string): Promise<string | null> {
    const room = await this.getRoom(roomId);
    const playlist = room.playlists.id(room.activePlaylistId);
    if (playlist === null) {
      return null;
    }

    const currentURL = room.playerState.url ?? "";
    const videoURLs = playlist.videos.map((v) => v.url);
    const index = videoURLs.indexOf(currentURL);
    const candidateURL = videoURLs[(index + 1) % videoURLs.length];
    if (candidateURL === undefined || candidateURL === currentURL) {
      return null;
    }

    return candidateURL;
  }

  async handleAction(roomId: string, action: ActionDTO): Promise<ActionDTO> {
    let payload = null;

    if (actions.addVideo.match(action)) {
      const { playlistId, video } = action.payload;
      const newVideo = await this.addVideoToPlaylist(roomId, playlistId, video);
      payload = { playlistId, video: newVideo };
    } else if (actions.deleteVideo.match(action)) {
      const { playlistId, videoId } = action.payload;
      await this.deleteVideoFromPlaylist(roomId, playlistId, videoId);
    } else if (actions.setPlaying.match(action)) {
      await this.setPlaying(roomId, action.payload);
    } else if (actions.setActiveURL.match(action)) {
      await this.setActiveURL(roomId, action.payload);
    }

    if (payload !== null) {
      const schema = (ActionDTO as TypeWithSchema<ActionDTO>).schema;

      if (schema === undefined) {
        return action;
      }

      return schema.cast(
        {
          ...action,
          payload,
        },
        {
          stripUnknown: true,
        },
      ) as ActionDTO;
    }

    return action;
  }

  async getRoomAndPlaylist(
    roomId: string,
    playlistId: string,
  ): Promise<{
    room: RoomDocument;
    playlist: PlaylistDocument;
  }> {
    const room = await this.getRoom(roomId);

    const playlist = room.playlists.id(playlistId);
    if (playlist === null) {
      throw new NotFoundException("Playlist not found");
    }

    return { room, playlist };
  }

  async addVideoToPlaylist(
    roomId: string,
    playlistId: string,
    videoDTO: VideoDTO,
  ): Promise<VideoDocument> {
    const { room, playlist } = await this.getRoomAndPlaylist(
      roomId,
      playlistId,
    );

    const existingVideo = playlist.videos.find(
      (video) => video.url === videoDTO.url,
    );
    if (existingVideo) {
      throw new BadRequestException("This video is already in the playlist");
    }

    const length = playlist.videos.push(videoDTO);
    await room.save();

    return playlist.videos[length - 1];
  }

  async deleteVideoFromPlaylist(
    roomId: string,
    playlistId: string,
    videoId: string,
  ): Promise<void> {
    const { room, playlist } = await this.getRoomAndPlaylist(
      roomId,
      playlistId,
    );

    const existingVideo = playlist.videos.id(videoId);
    if (existingVideo === null) {
      throw new NotFoundException("Video not found");
    }

    playlist.videos.remove(videoId);

    await room.save();
  }

  async setPlaying(roomId: string, playing: boolean): Promise<void> {
    const room = await this.getRoom(roomId);
    room.playerState.playing = playing;
    await room.save();
  }

  async setActiveURL(roomId: string, activeURL: string): Promise<void> {
    const room = await this.getRoom(roomId);
    if (activeURL === room.playerState.url) {
      return;
    }

    room.playerState.url = activeURL;
    room.playerState.playing = true;
    await room.save();
  }
}
