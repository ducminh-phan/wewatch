import {
  HttpException,
  UseFilters,
  UseInterceptors,
  UsePipes,
} from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { JwtService } from "@nestjs/jwt";
import {
  BaseWsExceptionFilter,
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from "@nestjs/websockets";
import { Namespace, Socket } from "socket.io";

import { MemberActionDTO } from "@/actions/member";
import { RoomActionDTO } from "@/actions/room";
import { SocketEvent } from "@/constants";
import { COMMON_INTERCEPTORS } from "interceptors";
import { AuthService } from "modules/auth";
import { UserDocument } from "modules/user/model";
import { WsValidationPipe } from "pipes/validation";
import {
  InternalEvent,
  MemberActionEventData,
  RoomActionEventData,
} from "utils/types";

import { MemberService } from "./member.service";
import { RoomService } from "./room.service";

interface SocketData {
  roomId: string;
  user: UserDocument;
}

interface SocketWithData extends Socket {
  data: SocketData;
}

const hasData = (socket: Socket): socket is SocketWithData => {
  return (
    typeof socket.data === "object" &&
    "roomId" in socket.data &&
    "user" in socket.data
  );
};

@UseFilters(new BaseWsExceptionFilter())
@UseInterceptors(...COMMON_INTERCEPTORS)
@UsePipes(new WsValidationPipe())
@WebSocketGateway({
  namespace: "rooms",
})
export class RoomGateway implements OnGatewayConnection, OnGatewayDisconnect {
  constructor(
    private readonly roomService: RoomService,
    private readonly memberService: MemberService,
    private readonly jwtService: JwtService,
    private readonly authService: AuthService,
  ) {}

  @WebSocketServer()
  server!: Namespace;

  async handleConnection(socket: Socket): Promise<void> {
    try {
      const accessToken = this.getAccessToken(socket);
      const { sub } = this.jwtService.verify(accessToken);
      const user = await this.authService.verifyJwtSubject(sub);

      const roomId = this.getRoomId(socket);
      socket.join(roomId);
      await this.memberService.handleJoinRoom(roomId, user);

      socket.data = {
        roomId,
        user,
      };
    } catch (e) {
      socket.disconnect();
    }
  }

  getAccessToken(socket: Socket): string {
    const accessToken: string | undefined = socket.handshake.auth?.accessToken;
    if (accessToken === undefined) {
      throw new Error("Access token is not provided");
    }

    return accessToken;
  }

  getRoomId(socket: Socket): string {
    const roomId = socket.handshake.query?.roomId;

    if (roomId === undefined) {
      throw new Error("roomId is not provided");
    }

    if (typeof roomId === "string") {
      return roomId;
    }

    return roomId[0];
  }

  async handleDisconnect(socket: Socket): Promise<void> {
    if (!hasData(socket)) return;

    const { roomId, user } = socket.data;
    await this.memberService.handleLeaveRoom(roomId, user);
  }

  @SubscribeMessage(SocketEvent.RoomAction)
  async handleRoomActionEvent(
    @ConnectedSocket() socket: Socket,
    @MessageBody() action: RoomActionDTO,
  ): Promise<void> {
    if (!hasData(socket)) {
      socket.disconnect();
      return;
    }

    const { roomId, user } = socket.data;

    try {
      const newAction = await this.roomService.handleAction(roomId, action);
      const wrappedAction = this.roomService.wrapAction(newAction, user);
      this.server.to(roomId).emit(SocketEvent.RoomAction, wrappedAction);
    } catch (e) {
      if (e instanceof HttpException) {
        throw new WsException(e.getResponse());
      }

      throw e;
    }
  }

  @OnEvent(InternalEvent.RoomAction)
  handleInternalRoomActionEvent({ roomId, action }: RoomActionEventData): void {
    const wrappedAction = this.roomService.wrapAction(action, null);
    this.server.to(roomId).emit(SocketEvent.RoomAction, wrappedAction);
  }

  @SubscribeMessage(SocketEvent.MemberAction)
  async handleMemberActionEvent(
    @ConnectedSocket() socket: Socket,
    @MessageBody() action: MemberActionDTO,
  ): Promise<void> {
    if (!hasData(socket)) {
      socket.disconnect();
      return;
    }

    const { roomId, user } = socket.data;

    try {
      await this.memberService.handleAction(roomId, user, action);
      const wrappedAction = this.memberService.wrapAction(action, user);
      if (wrappedAction) {
        this.server.to(roomId).emit(SocketEvent.MemberAction, wrappedAction);
      }
    } catch (e) {
      if (e instanceof HttpException) {
        throw new WsException(e.getResponse());
      }

      throw e;
    }
  }

  @OnEvent(InternalEvent.MemberAction)
  async handleInternalMemberActionEvent({
    roomId,
    user,
    action,
  }: MemberActionEventData): Promise<void> {
    const wrappedAction = this.memberService.wrapAction(action, user);
    if (wrappedAction) {
      this.server.to(roomId).emit(SocketEvent.MemberAction, wrappedAction);
    }
  }

  @SubscribeMessage(SocketEvent.SyncProgress)
  async handleSyncProgress(@ConnectedSocket() socket: Socket): Promise<number> {
    if (!hasData(socket)) {
      socket.disconnect();
      return 0;
    }

    let progress = 0;
    const { roomId } = socket.data;
    const socketsInRoom = await this.server.in(roomId).allSockets();

    const peerId = Array.from(socketsInRoom).find((id) => id !== socket.id);
    if (peerId !== undefined) {
      // Use Promise.race to set a timeout for getting progress from the peer
      progress = await Promise.race<Promise<number>>([
        new Promise((resolve) => setTimeout(() => resolve(0), 3000)),
        new Promise((resolve) => {
          try {
            this.server.sockets
              .get(peerId)
              ?.emit(SocketEvent.SyncProgress, (playedSeconds: number) =>
                resolve(playedSeconds),
              );
          } catch {
            resolve(0);
          }
        }),
      ]);
    }

    return progress;
  }
}
