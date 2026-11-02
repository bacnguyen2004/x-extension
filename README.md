# X Content Creator

## Bản 1.0.92: sửa Tạo Reply báo thiếu ngữ cảnh

Nút Tạo Reply với bài độc lập không còn bắt buộc JSON tự kiểm tra hội thoại. Chỉ dùng kiểm tra người nói khi thực sự có parent, lịch sử hoặc bài của chủ tài khoản. Prompt nêu rõ thiếu lịch sử không có nghĩa bài hiện tại không đủ để trả lời; nếu bài thật sự mơ hồ thì hỏi làm rõ ngắn gọn thay vì báo thiếu ngữ cảnh. Lỗi định dạng response được phân biệt với bản nháp sai người nói hoặc bài chỉ có media không đọc được chữ. Vẫn một request mặc định, giữ kiểm tra chống bịa thông tin, chống trùng và nguyên luồng Pogo. Reload extension rồi F5 tab X.

## Bản 1.0.91: giảm token ngoài Pogo

News Feed / nút ✨ / Mention mặc định một lần gọi AI. Bỏ lượt biên tập và viết lại tự động; kiểm tra độ dài Unicode, định dạng, lặp lại bài gốc, lời khen rỗng, hashtag spam và một số trường hợp sai ngôn ngữ bằng TypeScript. Bài rỗng, chỉ link/mention/media và bài đã xác nhận trả lời được lọc trước API. Draft bị loại không được job đăng phía sau tự soạn lại. Manual và ngữ cảnh chủ bài kiểm tra người nói, quy chiếu và giới hạn hình ảnh trong cùng response JSON; code chặn JSON/flags/vai không hợp lệ. Không cắt ngang câu để vừa 280 ký tự.

Prompt mặc định được rút gọn khi tạo request; giữ nguyên prompt/model tùy chỉnh, bài gốc đầy đủ và ngữ cảnh có nhãn. URL/ID được bỏ khỏi prompt mặc định khi không cần, vẫn giữ nếu template tùy chỉnh yêu cầu. Pogo Reply **và Quote từ Pogo** giữ nguyên prompt, tham số, lượt biên tập/viết lại. Không đổi Follow, điều hướng feed hoặc lịch nghỉ. Quote ngoài Pogo tiếp tục một lượt; hỗ trợ generator Post một lượt theo cấu hình, chưa bổ sung luồng tự đăng Post mới.

AI → Chi phí AI hiển thị riêng API requests, input, output và cached tokens theo tác vụ/model/endpoint, bổ sung nhãn Post. Không đổi dữ liệu lịch sử hoặc cách trừ cache khi tính tiền. Ngoại lệ tương thích nhà cung cấp: HTTP 400 từ chối Temperature vẫn được thử lại một lần theo cơ chế cũ.

So sánh offline cùng 13 mẫu: `npm run benchmark:ai` (Python cần `tiktoken`, cài bằng `python -m pip install -r scripts/benchmark-ai-requirements.txt`). Báo cáo tại `artifacts/token-optimization/REPORT.md`; số đếm tokenizer không phải hóa đơn hoặc bằng chứng chất lượng từ model thật. Reload extension từ `dist`, F5 X để dùng bản mới.

## Bản 1.0.90: Notifications tự động, ưu tiên phản hồi trực tiếp

Kiểm tra mỗi 15 phút tại điểm an toàn sau việc đang làm, không phụ thuộc số badge. Đọc Mentions trước, All bổ sung; tối đa 3 lượt cuộn và 3 cuộc hội thoại phù hợp mỗi đợt. Ưu tiên người trả lời bài/bình luận của bạn, sau đó mentions; bỏ qua sự kiện like/RT/follow, thông báo bài mới của KOL, chào hỏi ngắn và spam. Chống trùng Tweet ID giữa hai tab; gom hội thoại khi giao diện cung cấp conversation ID. Không dùng tỷ lệ random của feed hoặc yêu cầu Sorsa cho Notifications.

AI đọc bài/ngữ cảnh rồi tự đăng, không chờ duyệt; vẫn tuân thủ bật/tắt hành động, hạn mức, Stop và chống gửi trùng. Hoãn chuyển trang khi composer đang mở. Tạm dừng đồng hồ quét trong lúc xử lý thông báo, sau đó quay về nguồn trước đó và tiếp tục thời gian còn lại. Lưu vị trí cuộn theo tài khoản/tab; khôi phục vị trí là best effort khi X tải lại hoặc thay đổi nội dung feed. Reload extension và F5 X để dùng bản mới.

## Bản 1.0.89: hai tỷ lệ Follow độc lập khi lướt

Hành vi → Tỷ lệ tương tác có hai ô: Follow tác giả sau tương tác (%) và Follow từ danh sách khi lướt (%). Cấu hình cũ được chuyển tỷ lệ chung sang cả hai ô; giá trị 0 được giữ. Follow từ list vẫn cần bật nguồn tương ứng và chỉ áp dụng Home/Following; Follow tác giả dùng tùy chọn riêng trên Home/Following/Lists và ngưỡng Sorsa đã chọn. Có thể bật cả hai, không còn bật tác giả là bỏ danh sách. Dùng hai lần random độc lập sau khi quét; không random hai lần trước và sau quét cho cùng cơ hội.

Các tác vụ thực hiện lần lượt. Sau lượt Follow từ list, ưu tiên xét tương tác bài ở lượt tiếp theo để list 100% không chặn Like/Reply/Follow tác giả. Nếu không có tương tác bài được chọn thì vẫn có thể xử lý list. Giới hạn, lịch sử và chống trùng dùng chung. Tab Follow chạy riêng bằng nút Bắt đầu Follow vẫn xử lý danh sách tuần tự, không dùng hai tỷ lệ này. Preset tốc độ có thể đổi tỷ lệ tác giả như trước; tỷ lệ list đã lưu riêng được giữ. Reload extension, F5 X rồi chỉnh và Lưu.

## Bản 1.0.88: chỉnh ngưỡng Sorsa cho Follow feed

Thêm ô Hành vi → Tỷ lệ tương tác → Follow feed · Sorsa lớn hơn, mặc định 500 cho cả cấu hình cũ chưa có trường này. Nhập 500 nghĩa là chỉ xét tác giả có điểm >500; bằng ngưỡng hoặc thiếu điểm vẫn bỏ qua. Ngưỡng được lưu và kiểm tra khi thực hiện, kể cả job đang chờ; lý do tạo việc và thông báo bỏ qua dùng ngưỡng đã chọn. Vẫn cần bật Follow tác giả, hành động Follow, trúng tỷ lệ và có tương tác thành công. Các bộ lọc tab Follow vẫn áp dụng thêm. Không đổi ngưỡng Follow theo danh sách hoặc task Pogo. Reload extension, F5 X, chỉnh ô và Lưu cấu hình.

## Bản 1.0.87: Follow tác giả tại chỗ và tương tác sau Follow theo link

Thêm tùy chọn Follow ngẫu nhiên tác giả sau tương tác thành công trên Home/Following/Lists. Dùng tỷ lệ Follow đã cấu hình, bắt buộc Sorsa >1.000 (thiếu điểm thì bỏ qua), giữ bộ lọc tick/followers/blacklist/whitelist và ngân sách Follow dùng chung. Bật tùy chọn sẽ chọn tác giả thay cho danh sách username xen feed; tự bật hành động Follow trong form, cần Lưu cấu hình. Không đổi điều kiện Follow task Pogo. Hai tùy chọn mới mặc định tắt.

Follow tác giả ưu tiên menu ⋯ của đúng bài và đúng username, không mở profile mặc định. Lọc qua Sorsa trước, chỉ đọc profile nếu bộ lọc tick/followers yêu cầu hoặc không có cách Follow tại chỗ. Like kèm Follow tác giả trên Home/Following vẫn Like trên feed. Sau thao tác, kiểm tra Following/Requested; bấm xong chưa xác minh được thì ghi trạng thái chưa rõ và không fallback bấm tiếp. Menu đang mở sẵn không bị dùng lại; không chọn Unfollow. Chưa hỗ trợ hovercard; khi menu không khả dụng sẽ dùng profile. Quay lại nguồn bằng cơ chế Back hiện có, không mở lại Home mặc định.

Trong tab Follow → Nhập danh sách, thêm tùy chọn luôn Like + Reply bài mới nhất sau Follow thành công. Chỉ chạy với tài khoản mới Follow xác nhận, không chạy cho already-following hoặc yêu cầu tài khoản riêng tư. Chọn bài mới nhất trong các bài profile đã tải, bỏ repost/reply/quảng cáo và không nhầm bài ghim cũ. Dùng AI đã lưu, hạn mức Like/Reply và chống trùng; không chờ duyệt. Lưu tiến độ theo tài khoản và bài để tiếp tục, tối đa 3 lượt trong 5 phút; đổi cấu hình/tài khoản hoặc hết thời gian thì hủy phần còn chờ. Thiếu API/ngữ cảnh hoặc hết hạn mức có thể không gửi Reply.

Reload extension từ thư mục dist và F5 tab X để áp dụng. Chỉ mở sidepanel không cập nhật content script của tab đang mở.

## Bản 1.0.86: xử lý xác nhận rời trang và nháp còn sót

Thêm guard MAIN-world từ document_start trên X/Twitter để cho phép rời trang khi lệnh tự động đang hoạt động, tránh hộp beforeunload giữ tab rồi gây timeout liên tiếp. Quyền rời trang có thời hạn, giữ qua reload để phục hồi, được xóa khi nhận Stop hoặc extension context hết hiệu lực. Không cần quyền debugger. Guard chỉ có tác dụng từ lần tải trang có script mới; nếu hộp Chrome đang mở sẵn, bấm Rời khỏi một lần rồi Reload extension và F5 X.

Tự chọn Discard/Không lưu/Bỏ nháp ở hộp xác nhận nháp hoặc rời trang đã nhận diện, kể cả hộp xuất hiện muộn; không bấm nút xác nhận chung hay nút Save. Sau Reply/Quote, dọn đúng ô có nguyên văn nội dung agent vừa điền, kể cả khi timeout/hủy/không gửi được. Nội dung đã bị sửa thủ công được giữ. Kết quả gửi và bằng chứng chống gửi trùng giữ nguyên; lỗi dọn ô không ghi đè kết quả đã gửi.

Timeout hoặc mất kết nối lúc cuộn được ghi đúng lỗi, không còn gộp thành đang điều hướng để lặp mãi mà che nguyên nhân. Lỗi thực tế vẫn được tính và xử lý theo chính sách lỗi hiện tại. Đây không phải bỏ giới hạn phiên hoặc bỏ kiểm tra lỗi.

## Bản 1.0.85: chọn Like/Reply trực tiếp, bỏ tỷ lệ mở bài

Home/Following/Lists quét và lọc bài trước khi xét tỷ lệ hành động. Bỏ tỷ lệ mở bài và tách Like dạo; dùng một tỷ lệ Like chung. Chỉ Like trên Home/Following thì làm ngay trên feed; chọn Reply thì mở bài, đọc ngữ cảnh, soạn và tự gửi. Chọn cả Like và Reply thì giữ trong cùng một lần xử lý bài. Reply không còn tự ép Like khi tỷ lệ Like không chọn. Cấu hình cũ của tỷ lệ mở bài/Like dạo được bỏ qua, giữ tỷ lệ Like/Reply đang lưu. Pogo/list link giữ chính sách hành động riêng.

Không chọn hành động theo tỷ lệ không còn bị tính là nguồn hết bài. Chỉ lượt đã quét xác nhận không có bài mới rồi cuộn thành công mới tăng empty; loading/lỗi/lượt chỉ lướt không có kết quả quét không tăng. Bộ đếm giới hạn 3/3. Khi cần chuyển nguồn, dấu giữ lượt cũ không còn chặn chuyển; công việc ở nguồn khác hoặc đã hết hạn mức không giữ nguồn hiện tại. Vẫn hoàn tất việc đang xử lý tại nguồn trước khi chuyển. Lịch mặc định giữ 10–10–5 phút. Reload extension và F5 tab X để áp dụng.

## Bản 1.0.84: soạn xong tự đăng, bỏ bước duyệt

Bỏ giao diện Duyệt đăng/Bỏ qua, mục chờ duyệt, API duyệt và trạng thái duyệt trong hàng đợi. Reply/Quote được tự đăng sau khi AI soạn xong; bỏ công tắc chỉ lưu nháp. Cấu hình cũ từng tắt tự đăng không còn ngăn gửi. Nháp Mentions đã lưu được dùng tiếp, giữ đúng tài khoản và ngữ cảnh; không cần duyệt hoặc gọi AI soạn lại. Các việc đã bỏ qua hoặc đã gửi giữ nguyên, không được gửi lại.

Agent vẫn cần được Bắt đầu, bật thực thi, bật nguồn/hành động tương ứng và còn hạn mức. Tạm dừng và Kill switch vẫn ngăn gửi. Reload extension và F5 tab X để áp dụng; tiếp tục chạy để xử lý các nháp cũ.

## Bản 1.0.83: duyệt feed có bài mà không chờ hết spinner

Home, Following và Lists cho quét/cuộn ngay khi đúng nguồn và có bài dùng được, kể cả khi X còn spinner tải thêm hoặc chiều cao feed đang đổi. Bỏ chờ nội dung ổn định 400ms; vẫn chờ lần tải đầu chưa có bài và không coi bài rỗng/ẩn là nội dung dùng được. Khi đổi nguồn, spinner xuất hiện đơn thuần không cho phép đọc lại bài cũ: cần nội dung thay đổi, được gỡ rồi tải lại, hoặc một chu kỳ loading kết thúc.

Nếu vị trí không cuộn nhưng nội dung/chiều cao đổi trong lúc cuộn thì tính là feed đang tiến triển và xóa số lần kẹt liên tiếp. Spinner còn hiện không cản kiểm tra này. Vẫn phục hồi có giới hạn khi cuộn thực sự không di chuyển và nội dung không đổi. Nhật ký chờ cuộn chỉ ghi một tiền tố nguồn. Reload extension và F5 tab X để áp dụng content script mới.

## Bản 1.0.82: giới hạn thời gian chờ và phục hồi lệnh bị kẹt

Chờ feed, chờ cuộn và nghỉ sau chuyển trang đều kiểm tra hạn theo đồng hồ thực; timer bị chạy chậm không còn kéo dài vòng lặp theo số lần chờ. Mỗi lệnh trên tab X nhận hạn từ background và kiểm tra trước khi thao tác. Khi hết hạn, background gửi hủy đúng request ID, đợi tối đa 2 giây để nhận kết quả hoặc xác nhận giải phóng khóa. Kết quả thành công đến trong khoảng này vẫn được giữ. Nếu tab không phản hồi, thử reload đúng tab, tối đa một lần mỗi 5 phút trong phiên background; Stop hoặc đổi kết nối sẽ ngăn reload cũ.

`busy` giữ công việc ở trạng thái chờ, giữ nguồn đang duyệt và thử lại sau 5 giây; không cộng lỗi Like/RT hoặc kích hoạt tạm dừng vì 6 lỗi liên tiếp. Nhật ký ghi tên lệnh đang giữ khóa và thời gian đã chạy. Khóa chỉ mở khi lệnh cũ thực sự thoát. Cần Reload extension và tải lại tab X để thay content script cũ.

## Bản 1.0.81: tự hiện danh sách lệnh khi gõ `/` trong Telegram

Helper tự đăng ký `/start`, `/status`, `/today`, `/help` bằng `setMyCommands` cho chat đã cấu hình khi bật nhận lệnh bot. Đăng ký một lần theo bot/chat/danh sách lệnh, giữ qua khởi động lại; đăng ký lỗi sẽ thử lại ở lượt kiểm tra sau và không chặn nhận lệnh. Sau khi helper mới hoạt động khoảng một phút, mở lại chat bot và gõ `/` để xem gợi ý. Cập nhật cả `telegram_ops.py` và `telegram_ui.py` trên VPS; không cần chạy lại Setup-Monitoring để đăng ký menu slash.

## Bản 1.0.80: bot Telegram dễ theo dõi hơn

Thông báo dùng tiêu đề nổi bật, nhóm thông tin rõ ràng và giờ Việt Nam. Bounty có mã kèo, phí, slot còn, lý do lỗi và nút **Mở Pogo** để kiểm tra/join tay; phân biệt kèo mới, đã join, bị chặn, thất bại và chưa rõ kết quả. Thời gian trên tin Bounty là thời điểm sự kiện được xếp gửi, giữ nguyên khi thử gửi lại. Tin kèo mới/lỗi có thông báo bình thường; tin join thành công và báo cáo định kỳ gửi im lặng. Bot không cản Auto Join.

Khi đã bật lệnh bot, gửi `/start` hoặc `/help` để hiện menu **Trạng thái · Hôm nay · Hướng dẫn**. `/status` xem Agent, kết nối X/Pogo, VPS và số lượt; `/today` xem thống kê hôm nay. Báo cáo ngày cũng dùng cùng bố cục. Lệnh được đọc theo lịch khoảng một phút khi Chrome/helper hoạt động; chỉ người được cấu hình mới dùng được. Định dạng và nút URL theo [Telegram Bot API](https://core.telegram.org/bots/api#sendmessage).

Helper cần đủ `native-auth/telegram_notify.py`, `native-auth/telegram_ops.py` và **`native-auth/telegram_ui.py` mới**. Nếu VPS dùng bản sao ở nơi khác, cập nhật cả ba file; helper đã trỏ vào thư mục dự án này thì tự đọc mã mới ở lần gọi sau. Reload extension để dùng bản 1.0.80. Không cần cấu hình lại token bot hiện có. Cấu hình lệnh qua Setup-Monitoring mới cũng đăng ký thêm `/today` trong menu lệnh Telegram.

## Bản 1.0.79: giữ nguồn, chờ feed và phục hồi khi cuộn kẹt

Giữ Home/Following/Lists đủ đợt 3–6 lượt đã hoàn thành rồi mới vào đợt Thông báo. Xong Thông báo quay về nguồn trước đó, giữ đợt đang dở qua service worker khởi động lại. Sau khi chuyển nguồn, xác nhận đúng tab/list, chờ nội dung ổn định; không dùng bài cũ còn trên DOM làm nội dung nguồn mới và không bấm lại tab liên tục khi đang chuyển. Thông báo dạng card không có article cũng được nhận diện là nội dung đã tải.

Đo lại vị trí sau lệnh cuộn để đợi Chrome phản hồi; chỉ tính lượt khi có tiến triển. Theo dõi bài và chiều cao feed khi chưa cuộn được. Kẹt 3 lần thì về đầu nguồn, 6 lần thì reload; tối đa một lần reload mỗi 5 phút cho mỗi nguồn, giới hạn giữ qua reload trang. Nếu vẫn kẹt thì tạm bỏ nguồn đó 2 phút và dùng nguồn khác đang bật; hết nguồn thì chờ, không ép mở Home. Stop hủy việc chờ và phục hồi. Nhật ký phân biệt chờ đúng nguồn, đang tải, cuối phần nội dung đã tải, cuộn chưa phản hồi và các bước phục hồi.

Sau build: **Reload extension rồi F5 các tab X** để nạp content script mới. Chức năng Bounty của 1.0.78 giữ nguyên.

## Bản 1.0.78: báo kèo Bounty trước khi tự join

Phát hiện kèo join được → bắt đầu gửi bot ngay → tự join → báo kết quả từng kèo. Không chờ bot phản hồi để join; kèo miễn phí không yêu cầu ví không phải chờ API số dư. Quét Bounty định kỳ 30 giây trên Chrome 120+, độc lập với Agent; Chrome có thể giao alarm trễ. Tin Bounty gửi lỗi được lưu và thử lại ở các lượt quét sau trong 24 giờ, chống trùng theo tài khoản và kèo. Tin báo lỗi/chưa rõ kết quả có lý do, mã kèo và link mở Pogo để kiểm tra, join tay.

Giữ cấu hình mới nhất khi tắt Auto Join, không ghi đè kết quả join đồng thời, và không mang trạng thái đã join sang tài khoản khác. Lỗi mạng/HTTP 5xx hoặc phản hồi không xác định sau POST được báo là chưa rõ kết quả; không tự gửi lại POST, tiếp tục đối soát từ danh sách Pogo. Nếu chưa xác nhận được, mở Pogo kiểm tra và join tay. Lỗi tải danh sách/phiên đăng nhập cũng báo bot. Cần dùng `native-auth/telegram_notify.py` mới cùng extension và Reload extension sau build.

## Bản 1.0.77: ở lại nguồn theo đợt

Home, Following và Lists ở lại 3–6 lượt cuộn hoặc xử lý bài trước khi chọn lại nguồn theo trọng số. Một bài có nhiều hành động chỉ tính một lượt khi đã xử lý xong; chuyển trang và lượt bị dừng không trừ số lượt. Back về nguồn tiếp tục đợt hiện tại. Đợt được giữ qua việc service worker ngủ/dậy; tắt nguồn sẽ hủy đợt của nguồn đó. Thông báo vẫn dùng chính sách đợt riêng. Nhật ký ghi số lượt đã hoàn thành; tab Hành vi giải thích cách chọn nguồn theo đợt.

## Bản 1.0.76: nghỉ sau khi chuyển trang

Trước khi quét bài, cuộn hoặc tương tác trên trang vừa mở, nghỉ ngẫu nhiên 3–5 giây. Áp dụng cả khi đổi tab Home/Following cùng URL và sau Back về nguồn. Các lệnh tiếp theo trên cùng trang không lặp lại khoảng nghỉ này; thời gian đọc bài và nghỉ giữa hành động vẫn giữ nguyên. Nếu Follow mở profile, có nghỉ giữa hai bước Back qua bài về nguồn. Stop hủy việc tiếp tục trong lúc chờ.

## Bản 1.0.75: dùng mũi tên Back của X

Hoàn thành các hành động của bài rồi bấm mũi tên Back để quay về nguồn vừa mở bài: Home, Following, Lists hoặc Thông báo. Nếu Follow mở thêm profile, Back về bài rồi về nguồn. Đã ở nguồn thì giữ nguyên trang. Bỏ bộ nhớ lịch sử/vị trí cuộn và đường dẫn Lists dự phòng của bản 1.0.73–1.0.74; việc khôi phục vị trí do X xử lý. Không thấy nút hoặc Back không thành công thì ghi log, không tự mở lại URL trong bước quay lại. Stop ngăn bấm Back. Sau đó tiếp tục chính sách chọn nguồn hiện có.

Chrome MV3 extension: **agent tự động trên X** (Like / RT / Reply / Follow / Quote, AI draft, delay, Kill switch).

## Bản 1.0.74: sửa điều kiện Back và trường hợp Follow

Không còn yêu cầu `history.length` tăng sau khi mở bài: nguồn Lists đã lưu và đúng bài hiện tại xác định đường quay lại. Sau Follow, cho phép Back từ đúng profile vừa xử lý về đúng bài gốc rồi về Lists, tối đa hai bước; dừng nếu gặp trang khác. Log dự phòng ghi thêm lý do thiếu lịch sử, thiếu nguồn đã lưu hoặc Back không tới đúng nơi. Vẫn giữ vị trí cuộn và chọn nguồn lượt sau theo tỷ lệ.

## Bản 1.0.73: Back về Lists sau khi tương tác

Ghi nhớ Lists và vị trí cuộn trước khi mở bài. Hoàn thành các hành động của bài rồi mới bấm Back trên X (hoặc Back trình duyệt khi không có nút). Nếu đã ở đúng Lists, giữ nguyên trang. Lượt kế tiếp vẫn chọn Home/Following/Lists theo trọng số đã đặt; không ép tiếp tục Lists. Chỉ dùng đường dẫn Lists dự phòng khi không có lịch sử phù hợp hoặc Back không đưa về đúng Lists. Stop chặn cả bước quay lại.

## Bản 1.0.72: tách xác suất mở bài của Lists

Mỗi lượt vào tab Lists luôn quét bài, không chịu xác suất mở bài Home/Following. Tỷ lệ của từng hành động Like/Reply/Follow và các công tắc, hạn ngày vẫn được giữ. Hàng đợi hiện đúng tên Lists/Following/Thông báo thay vì ghi Home cho mọi tác vụ cuộn. Cấu hình nâng cao ghi rõ phạm vi áp dụng của từng tỷ lệ.

## Bản 1.0.71: Lists và Thông báo

- Giữ nguồn và lựa chọn tương tác trong lúc chuyển sang Lists/Following; không chọn lại Home giữa chừng. Đợi tối đa 8 giây cho timeline xuất hiện trước khi kết luận không có bài.
- Bỏ ô tỷ lệ Thông báo. Các đợt thông báo mới đủ điều kiện được xử lý riêng, không dùng trọng số xoay nguồn hoặc % Reply của feed. Mỗi đợt chọn tối đa 3 bài, ưu tiên phản hồi trực tiếp; bỏ qua thông báo like/RT/follow.
- Reply Thông báo tự đăng sau khi AI soạn xong khi Agent đang chạy, nguồn/Reply còn bật và còn hạn mức. Không có bước duyệt hoặc công tắc chỉ lưu nháp.
- Hoàn thành các tác vụ Thông báo đã chọn rồi mới quay về Home. Giữ kiểm tra đúng tài khoản, hạn ngày và chống reply trùng.

## Bản 1.0.70: rà soát dự án

- Chuyển nội dung bài đọc trên X vào yêu cầu AI cho cả tác vụ đơn và nhóm; trước đây list link có thể tạo reply thiếu nội dung bài. Soạn quote cũng đọc bài trước khi tạo nội dung.
- Khi lưu username mới, mở lại reply bị lỗi `reply_identity_missing` trước khi gửi; giữ nguyên các reply đã gửi hoặc bị mất kết nối trong lúc gửi.
- Giới hạn chờ API SMM ở 15 giây, từ chối chuyển hướng và kiểm tra chính xác đường dẫn bài X trước khi tạo đơn.

## Bản 1.0.69: sửa gửi reply và bỏ qua bài chính chủ

Vào **Nguồn → Tài khoản X của bạn**, nhập `@username` của tài khoản đang đăng nhập và bấm **Lưu username**. Pogo và list link sẽ bỏ qua bài của tài khoản này, kể cả công việc đang chờ trong hàng đợi. Username đã lưu cũng được dùng khi X ẩn thông tin tài khoản trên giao diện.

Reply chuyển sang **Đã gửi** sau khi bấm gửi thành công; không chờ thông báo xác nhận từ X hoặc lên lịch kiểm tra lại reply qua Pogo. Vẫn giữ lịch sử để tránh gửi trùng. Các reply cũ bị bỏ qua do `reply_identity_missing` được mở lại để xử lý; lỗi xảy ra trước khi gửi sẽ báo lỗi gửi, không hiện “Chờ xác minh”. Điểm Pogo vẫn lấy từ dữ liệu Pogo trả về khi làm mới nguồn.

**Pogo** là một **nguồn task tùy chọn** — không phải toàn bộ sản phẩm. Bạn có thể chạy chỉ lướt Home, chỉ Pogo, hoặc Pogo trước rồi lướt X.

## AI: News Feed và Mentions

Tab **AI → 03 · Chi phí AI** thống kê hôm nay, tháng này và toàn bộ từ khi bắt đầu ghi nhận, theo giờ Việt Nam. Mỗi lần gọi API đều được ghi riêng, gồm soạn, biên tập, viết lại, kết quả `SKIP_REPLY` và phản hồi bị cắt vì hết token. Lỗi mạng/HTTP hoặc response thiếu usage hiển thị là lượt chưa rõ usage; không tự suy đoán số token hay coi đó là miễn phí.

Mở **Đơn giá từng model**, nhập giá đầu vào, đầu vào cache và đầu ra theo **USD / 1 triệu token**, rồi **Lưu đơn giá**. Dùng giá thực tế của nhà cung cấp/proxy. Nếu không có giá cache riêng, nhập bằng đầu vào. Ba ô trống nghĩa là chưa đặt giá, số 0 nghĩa là miễn phí. Model và địa chỉ API được phân biệt riêng; đổi đơn giá sẽ tính lại lịch sử theo bảng giá hiện tại. Bấm **Cập nhật thống kê** để lấy các lượt mới và model vừa thay đổi. Không tự lấy giá thị trường hoặc đồng bộ hóa đơn.

Token lấy từ `usage.prompt_tokens`, `usage.completion_tokens` và `usage.prompt_tokens_details.cached_tokens`; cache được trừ khỏi đầu vào thường trước khi tính. Reasoning đã thuộc completion tokens nên không cộng thêm lần nữa ([tham khảo API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)). Đây là ước tính phần token, chưa gồm thuế, tín dụng, phí công cụ/media/cache write riêng. Khi thiếu usage/đơn giá, giao diện ghi rõ tổng chưa đầy đủ. Chưa có chức năng giới hạn ngân sách tự động.

Dữ liệu chi phí lưu tại `xContentCreator.aiUsage.v1` trong Chrome local storage, giữ qua reload, riêng từng Chrome profile/VPS; không chứa nội dung prompt, reply, API key hoặc query xác thực của URL. Không khôi phục chi phí cũ hoặc các lời gọi ngoài extension.

Tab **AI → Hướng dẫn viết nội dung** có System Prompt và User Prompt riêng cho Pogo, News Feed/Nút ✨ và Mentions. Để trống model của từng mục để dùng model chung. Prompt mặc định cũ của News Feed/Mentions tự cập nhật; prompt đã tùy chỉnh được giữ lại. Có thể dùng nút khôi phục hướng dẫn để áp dụng mẫu mới.

Chỉ có một nút **✨ Tạo Reply**: bài thường dùng News Feed; bài có mention hoặc tín hiệu reply trực tiếp tới tài khoản đang đăng nhập dùng Mentions, sau khi background kiểm tra cùng tài khoản của tab X. Nếu không xác định được quan hệ/tài khoản thì dùng News Feed. Nút đọc bài trước khi mở composer, kèm ngữ cảnh phía trước khi đang xem thread, không lấy bài liền trước trên Home làm hội thoại. Ngữ cảnh có sẵn tự bổ sung vào yêu cầu AI cả khi template tùy chỉnh chưa có hai biến mới. Không đổi prompt người dùng đã lưu. Cả hai chế độ của nút đều không cho SKIP_REPLY và chỉ dán nháp, người dùng tự bấm Post.

Từ **1.0.67**, lượt kiểm tra thứ hai của nút ✨ yêu cầu JSON gồm `reply`, `correct_recipient`, `correct_attribution` và `unsupported_visual_claims`. Chỉ lấy nội dung `reply` khi đánh giá đủ điều kiện và qua kiểm tra độ dài/chất lượng. JSON không hợp lệ hoặc kiểm tra sai người/gán nhầm chi tiết sẽ yêu cầu viết lại một lượt; vẫn lỗi thì trả `reply_grounding_failed`, không dán nháp. Áp dụng cả nhánh News Feed dự phòng và khi chưa đọc được ngữ cảnh; mô tả bài cha không được coi là ảnh của tác giả hiện tại. Nhánh có ngữ cảnh cũng nhận quy tắc phân biệt tác giả dù đang dùng News Feed. Đây là đánh giá của model, không phải xác minh độc lập nội dung ảnh. Thông thường giữ hai lượt gọi AI, chỉ thêm lượt khi cần viết lại. Thông báo nháp sẵn sàng hiển thị **Mentions / News Feed** thực tế từ background.

**1.0.68 — phản hồi bình luận dưới bài của chính mình:** đọc riêng bài của tài khoản đang đăng nhập (`ownerPost`), bình luận được chọn và người sẽ phản hồi. Trong trang thread, nếu thấy bài của bạn phía trước bình luận người khác, nút dùng Mentions dù X không hiện dòng Replying to. Vẫn ghi rõ đó là ngữ cảnh thread, không tự coi là permalink xác nhận bài cha. Trên Home không lấy bài liền trước làm bài gốc.

Nếu đã đọc được bài của bạn nhưng tài khoản tab và background không khớp, công cụ báo `reply_identity_mismatch`; không bỏ dữ liệu vai rồi âm thầm tạo bằng News Feed. Agent giữ riêng bài của bạn và bình luận cần trả lời trong ngữ cảnh soạn Mentions.

Khi có dữ liệu bài của bạn, lượt AI đầu tiên nhận **bài của bạn → bình luận → vai phản hồi**, trả diễn giải ý bình luận và bản nháp cùng username/tweet ID của hai bên. Code kiểm tra các vai và ID trước khi sang lượt kiểm tra nháp. Lượt kiểm tra phải xác nhận thêm `correct_perspective` và `intent_consistent`: ví dụ không hỏi Henry vì sao đổi avatar khi Henry đang gợi ý chủ bài dùng ảnh Muse làm avatar. Không bắt mọi bình luận ngắn thành câu hỏi làm rõ. Quy tắc áp dụng cho cả nút ✨ và Mentions của Agent; dữ liệu bài của bạn giữ qua bridge, queue và reload. Thông thường hai lượt gọi, tối đa ba lượt tính cả thử lại phần diễn giải hoặc viết lại; lỗi xác định vai trả `reply_understanding_failed`. Đây vẫn là diễn giải của model dựa trên nội dung đọc được, không bảo đảm mọi câu trả lời đều đúng ý người bình luận.

Prompt Mentions mặc định nay phân biệt **CURRENT MENTION / PARENT POST / ACCOUNT OWNER / OTHER AUTHOR**, không gán mô tả plush/hoodie/ảnh trong bài cha cho người đang reply. Quy tắc chính xác ngữ cảnh được áp dụng cả khi dùng prompt tùy chỉnh. Chỉ mẫu mặc định cũ được tự migrate; nội dung tự viết được giữ lại.

Biến mới `{{already_replied}}` hỗ trợ `true` khi có bằng chứng đã trả lời đúng tweet ID, hoặc `unknown` khi thiếu bằng chứng. Không tự suy ra `false` chỉ vì chưa thấy reply. Agent có kiểm tra trước lúc soạn/đăng; nút ✨ kiểm tra lịch sử theo **tài khoản + tweet ID** và các reply của bạn có permalink xác định đúng bài cha. Bài của chính bạn nằm gần đó, một link trong nội dung hoặc bài trích dẫn không đủ để kết luận trùng. X không hiển thị quan hệ rõ ràng thì vẫn là unknown.

Sau khi nút ✨ tạo nháp, chỉ khi bạn thực sự bấm Post trong composer tương ứng mới ghi nhận lần gửi ở `xcc.reply-attempt.v1.<account>.<tweetId>`. Đây là trạng thái **submitted**, chưa phải xác nhận X đã đăng thành công; lần gửi chưa rõ kết quả được chặn để bạn kiểm tra thay vì gửi lại. Không ghi nhận khi chỉ tạo nháp, không tự bấm Post và không gộp tweet mới trong cùng thread với tweet cũ. Reply thủ công ngoài luồng tạo nháp không tự có lịch sử này; chỉ được nhận diện khi có bằng chứng DOM phù hợp. Quy tắc nút/list link không nhận SKIP_REPLY từ AI vẫn giữ; chặn trùng là kiểm tra code trước khi gọi AI.

News Feed dùng cho Home, Following, Lists, danh sách link và nút ✨: đóng góp góc nhìn có căn cứ, theo ngôn ngữ bài đăng, thường 15–45 từ. Lướt News Feed ngẫu nhiên được phép trả `SKIP_REPLY`. **Nút ✨ và danh sách link là yêu cầu có chủ đích nên không nhận `SKIP_REPLY`**, cả ở lượt soạn lẫn kiểm tra/viết lại. Nếu thiếu ngữ cảnh, AI trả lời phần có căn cứ hoặc hỏi làm rõ. Nếu model vẫn trả SKIP sau số lần viết lại giới hạn, báo lỗi chất lượng thay vì coi là bỏ qua thành công hay đăng nguyên marker.

Mentions chỉ chọn mention/reply trực tiếp tới tài khoản X đang dùng, trả lời ngắn theo ngôn ngữ mention, thường 5–35 từ; lời chào có thể ngắn hơn. Mentions vẫn được phép `SKIP_REPLY` khi spam hoặc thiếu ngữ cảnh thiết yếu. Các reply giới hạn 280 ký tự. Pogo giữ cơ chế viết reply hiện tại.

Để chạy Mentions, bật nguồn **Thông báo** và hành động **Reply** trong Hành vi, lưu rồi Start. Agent soạn xong sẽ tự đăng khi đúng tài khoản và chưa đủ hạn ngày; không có bước duyệt. Nháp cũ được dùng tiếp, không cần soạn lại. Tạm dừng, tắt nguồn/Reply hoặc tắt thực thi sẽ ngăn gửi.

Biến template: `{{author}}`, `{{text}}`, `{{tweet_url}}`, `{{tweet_id}}`, `{{parent_text}}`, `{{conversation_context}}`. Với Mentions, extension đọc tối đa ba bài phía trước trong thread đang mở. `parent_text` chỉ có khi tìm được liên kết xác định bài cha; nếu chỉ thấy bài trước đó, nội dung nằm trong `conversation_context` với nhãn chưa xác minh quan hệ. Ngữ cảnh không tải được sẽ để trống; AI được yêu cầu không đoán bài ẩn, nội dung media hoặc hoạt động cá nhân của chủ tài khoản. Bản nháp đã lưu giữ qua reload và được tự đăng khi Agent chạy, đúng tài khoản và còn hạn mức.

## Cài đặt

Mặc định bật **Nghỉ linh hoạt theo tải** trong Hành vi. Từ 20 task đang chờ hoặc 30 thao tác hoàn tất trong đợt: chạy 30 phút/nghỉ 20; từ 5 task hoặc 10 thao tác: 45/15; thấp hơn: 60/10. Ngân sách chạy chỉ cộng thời gian xử lý và khoảng chờ giữa các tác vụ có việc, không cộng thời gian chờ hết task, lỗi hay thời gian Chrome đóng. Các mốc là cấu hình quản lý tải thử nghiệm, không bảo đảm tránh giới hạn nền tảng.

Hết task: chờ 5–10 phút theo mốc polling Pogo; nếu đang chờ biên nhận đối soát thì thức sớm hơn để kiểm tra. Lỗi mạng: chờ 1 → 2 → 5 → 15 phút, có giới hạn tần suất và tự phục hồi. Lỗi cấu hình hoặc tín hiệu giới hạn/xác minh tài khoản X: dừng để người dùng xử lý. Giữ hàng đợi và lưu `runtime.adaptiveRest.resumeAt` qua reload; thời gian nghỉ tự nhiên đủ dài thay cho nghỉ định kỳ, không cộng dồn. Dừng thủ công/Dừng khẩn không tự khởi động lại. Quản lý Bearer và thông báo Telegram tiếp tục qua alarm riêng khi Agent nghỉ. Cơ chế này áp dụng cho Agent, không thay lịch của các chế độ Follow/Unfollow/SMM riêng.

1. `npm install && npm run build`
2. Chrome → `chrome://extensions` → **Developer mode** → **Load unpacked** → chọn thư mục **`dist/`**
3. Pin extension → mở **Side Panel**

Sau mỗi lần sửa code: `npm run build` → **Reload** extension → F5 tab `x.com`.

Pogo dùng API: bật tự cấp Bearer qua phiên Telegram ở tab Nguồn. Task, retweet power và giờ đối soát lấy từ `GET /api/feed`. Token tự gia hạn bằng helper trên máy; hàng đợi được giữ.

Thiết lập helper: xem [thiết lập local auth](native-auth/README.md). Cần phiên Telethon còn hợp lệ. API ID/hash riêng chưa đủ để cấp Bearer.

Agent mặc định bật **Chạy liên tục 24/24** trong tab Hành vi: không tự dừng tại giới hạn vòng/session. Giới hạn hành động mỗi ngày vẫn giữ nguyên. Nếu chọn nghỉ khi đủ mục tiêu hoặc không bật lướt Home, Agent chờ tới 00:00 giờ Việt Nam rồi tự tiếp tục. Tắt chạy liên tục để dùng lại giới hạn vòng. Dừng thủ công và Dừng khẩn vẫn cần người dùng bấm Start để chạy lại. Chrome, VPS và phiên X phải còn hoạt động; extension không chạy khi Chrome đã đóng hoặc máy ngủ.

Follow List tự loại người đã follow hoặc đã gửi yêu cầu khỏi lượt chạy sau. Lịch sử lưu riêng theo tài khoản X, giữ qua Stop/Start, reload extension và đổi ngày; không phụ thuộc queue Agent. Extension ghi nhận khi thấy trạng thái đang follow hoặc nhận kết quả follow từ X. Unfollow qua extension sẽ xóa người đó khỏi lịch sử; thao tác unfollow thủ công bên ngoài chưa tự đồng bộ.

Khi Follow thành công, đã gửi yêu cầu hoặc phát hiện đã Following sẵn, username tự chuyển từ list nguồn sang **Đã Following** trong cùng lần lưu. Người chưa xử lý hoặc Follow lỗi vẫn ở list nguồn. Khi dán lại list cũ rồi Lưu/Bắt đầu, những người đã có trong lịch sử của tài khoản X hiện tại cũng được loại khỏi list chờ.

Trong tab Follow/Unfollow có mục **Đã Following** dùng chung: tìm username, lọc tick/follow back, mở profile và xuất CSV theo bộ lọc hiện tại. Khi lướt X, extension ghi nhận các tài khoản có trạng thái Following trên UserCell, profile hoặc bài đang hiện; thông tin chưa quan sát được để “chưa rõ”. Điểm Sorsa dùng kết quả đã tra trong cache (badge Sorsa cũng cập nhật cache này). Đây là dữ liệu ghi nhận gần nhất, không phải lần quét toàn bộ Following hay xác minh follow back trực tiếp mỗi lần mở danh sách. Danh sách cũ tự đọc được, không mất khi nâng cấp.

## Setup 1 lần rồi Start

1. **AI** — lưu API key (OpenAI GPT hoặc xAI) để soạn Reply/Quote  
2. **Sources** — (tuỳ chọn) dán Bearer token Pogo API nếu dùng campaign Pogo; Quét để cập nhật task + RT power
3. Đăng nhập **x.com** trên cùng Chrome  
4. **Behavior** — bật Modules (Pogo / Home) + Actions, chọn delay an toàn → Lưu  
5. **Agent** → **Start** (tự mở/focus `x.com/home`)

Mỗi bài agent làm theo Actions đã bật (vd. Like → Reply → RT → Follow), nghỉ giữa các bước, rồi sang bài khác.

## Tab Side Panel

| Tab | Việc |
|-----|------|
| Agent | Start / Pause / Kill, Tab X, hàng đợi, setup |
| Sources | Pogo API + list link bài X (tùy chọn) |
| Behavior | Delay, Modules, Actions, ưu tiên nguồn |
| AI | Provider, key, model, prompts reply/quote |
| Activity | Log hành động |

## Modules (Behavior)

| Module | Ý nghĩa |
|--------|---------|
| Pogo campaigns | Lấy task từ Pogo |
| Lướt Home (X) | Engage / cuộn timeline X |
| Following / Lists | Dự kiến mở rộng |

Ưu tiên: `Pogo trước → rồi lướt X` · `Chỉ Pogo` · `Chỉ lướt X`.

## An toàn

- Dùng preset **safe** / delay dài lúc đầu  
- **Kill switch** dừng khẩn cấp  
- ≥6 lỗi X liên tiếp → agent tự tạm dừng  
- Automation X có rủi ro hạn chế tài khoản / ToS

## Dev

```bash
npm test
npm run build
```

Load unpacked từ `dist/`.
