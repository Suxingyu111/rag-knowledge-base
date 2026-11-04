"""项目自定义异常。

所有业务异常继承 :class:`AppException`，统一携带 ``code`` / ``http_status`` /
``message`` / ``details``，便于在 API 层转换成一致的错误响应体::

    {
        "code": "not_found",
        "message": "资源不存在",
        "details": null
    }
"""

from http import HTTPStatus
from typing import Any


class AppException(Exception):
    """所有业务异常的基类。

    子类通过类属性声明默认的 ``code`` / ``http_status`` / ``message``；
    实例化时可以覆盖它们，并附带 ``details`` 补充上下文。
    """

    code: str = "internal_error"
    message: str = "服务内部错误"
    http_status: HTTPStatus = HTTPStatus.INTERNAL_SERVER_ERROR

    def __init__(
        self,
        message: str | None = None,
        *,
        code: str | None = None,
        http_status: HTTPStatus | None = None,
        details: Any = None,
    ) -> None:
        if message is not None:
            self.message = message
        if code is not None:
            self.code = code
        if http_status is not None:
            self.http_status = http_status
        self.details = details
        super().__init__(self.message)

    def to_dict(self) -> dict[str, Any]:
        """转换为统一的错误响应体。"""
        return {
            "code": self.code,
            "message": self.message,
            "details": self.details,
        }


class BadRequestError(AppException):
    """请求参数不合法。"""

    code = "bad_request"
    http_status = HTTPStatus.BAD_REQUEST
    message = "请求参数错误"


class UnauthorizedError(AppException):
    """未登录或登录态失效。"""

    code = "unauthorized"
    http_status = HTTPStatus.UNAUTHORIZED
    message = "未登录或登录已失效"


class NotFoundError(AppException):
    """请求的资源不存在。"""

    code = "not_found"
    http_status = HTTPStatus.NOT_FOUND
    message = "资源不存在"


class ConflictError(AppException):
    """资源状态冲突，例如重复创建。"""

    code = "conflict"
    http_status = HTTPStatus.CONFLICT
    message = "资源冲突"


class UnprocessableEntityError(AppException):
    """请求格式正确但语义无法处理。"""

    code = "unprocessable_entity"
    http_status = HTTPStatus.UNPROCESSABLE_ENTITY
    message = "请求内容无法处理"


class TooManyRequestsError(AppException):
    """触发限流。"""

    code = "too_many_requests"
    http_status = HTTPStatus.TOO_MANY_REQUESTS
    message = "请求过于频繁，请稍后再试"


class PermissionDeniedError(AppException):
    code = "permission_denied"
    message = "无权访问该资源"
    http_status = HTTPStatus.FORBIDDEN


class ConfigurationError(AppException):
    code = "configuration_error"
    message = "服务配置缺失"
    http_status = HTTPStatus.SERVICE_UNAVAILABLE


class ValidationError(AppException):
    code = "validation_error"
    message = "参数校验失败"
    http_status = HTTPStatus.BAD_GATEWAY
