export default function setupSocket(io) {
  io.on("connection", (socket) => {
    console.log("Client connected", socket.id);

    socket.on("disconnect", () => {
      console.log("Client disconnected", socket.id);
    });

    socket.on("new-assignment", (data) => {
      io.emit(`assignment-update-${data.courseId}`, data);
    });

    socket.on("new-resource", (data) => {
      io.emit(`resource-update-${data.courseId}`, data);
    });

    socket.on("attendance-marked", (data) => {
      io.emit(`attendance-update-${data.courseId}`, data);
    });

    socket.on("new-submission", (data) => {
      io.emit(`submission-update-${data.assignmentId}`, data);
    });

    socket.on("admin-update", (data) => {
      io.emit("admin-update", data);
    });
  });
}

