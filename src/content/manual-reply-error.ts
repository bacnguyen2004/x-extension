export function manualReplyError(error?: string, detail?: string): string {
  if (error === "reply_grounding_failed" && detail === "invalid_review_format") {
    return "AI trả sai định dạng bản nháp. Chưa dán nội dung; thử tạo lại.";
  }
  const messages: Record<string, string> = {
    already_replied: "Bạn đã trả lời đúng bài này.",
    reply_attempt_exists: "Đã có lần gửi reply, cần kiểm tra kết quả trên X.",
    reply_history_unavailable: "Chưa kiểm tra được lịch sử reply. Thử lại sau.",
    source_text_missing: "Chưa đọc được chữ trong bài này. Nếu bài chỉ có ảnh/video, cần thêm nội dung mô tả để tạo reply chính xác.",
    reply_grounding_failed: "Bản nháp chưa đạt kiểm tra người nói hoặc thông tin được nhắc đến. Chưa dán nội dung; thử tạo lại.",
    reply_understanding_failed: "AI chưa xác định đúng vai chủ bài và người bình luận. Chưa tạo bản nháp.",
    reply_quality_failed: "Bản nháp chưa đạt yêu cầu về nội dung, ngôn ngữ hoặc độ dài. Chưa dán nội dung; thử tạo lại.",
    reply_identity_mismatch: "Tài khoản X của tab chưa khớp với kết nối extension. F5 tab X rồi thử lại.",
    reply_context_invalid: "Chưa xác định được bài của bạn và bình luận tương ứng. Mở lại thread rồi thử lại.",
  };
  return messages[error || ""] || error || "AI soạn thất bại — kiểm tra tab AI / API key";
}
